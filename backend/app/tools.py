"""Typed tool registry and the single execution path every tool call goes through.

run_tool() order of checks:
  1. registry lookup      - unknown tools are blocked (POL-UNKNOWN)
  2. schema validation    - strict Pydantic models, extra fields forbidden
  3. policy decision      - policy.py, evaluated here at execution time
  4. approval binding     - approval-required actions need an approval whose hash matches these exact args
  5. execution            - in-process, or over MCP for MCP-exposed read-only tools
  6. persistence          - sanitised tool_calls row with result, duration, attempt, transport
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit, policy, rag, runtime_settings, sandbox
from app.models import ApprovalRequest, Ticket, ToolCall, WorkflowRun, WorkflowStep
from app.security import sanitize


class ToolError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind  # transient | permanent | validation | timeout
        self.message = message


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


SandboxId = Field(pattern=r"^SBX-[A-Z]{2,4}-[A-Z0-9]{4,10}$", max_length=40)
Category = Literal["vpn", "wifi", "account", "email", "printer", "performance", "unclassified", "security_policy", "other"]
Priority = Literal["low", "medium", "high", "critical"]


# ------------------------------------------------------------------ input schemas
class SearchKBInput(StrictModel):
    query: str = Field(min_length=2, max_length=500)
    top_k: int | None = Field(default=None, ge=1, le=10)


class DeviceInput(StrictModel):
    device_id: str = SandboxId


class AccountInput(StrictModel):
    account_id: str = SandboxId


class NetDiagInput(StrictModel):
    device_id: str = SandboxId
    target: Literal["internet", "vpn", "wifi", "mail"]


class ServiceInput(StrictModel):
    service: Literal["vpn-gateway", "wifi-controller", "identity-provider", "mail-service", "print-server"]


class CreateTicketInput(StrictModel):
    title: str = Field(min_length=3, max_length=200)
    description: str = Field(min_length=1, max_length=4000)
    category: Category
    priority: Priority


class UpdateTicketInput(StrictModel):
    ticket_id: str = Field(max_length=40)
    status: Literal["open", "in_progress", "waiting_on_user", "pending_approval", "escalated", "resolved", "closed", "cancelled"] | None = None
    priority: Priority | None = None
    category: Category | None = None
    title: str | None = Field(default=None, max_length=200)
    resolution: str | None = Field(default=None, max_length=2000)
    note: str | None = Field(default=None, max_length=1000)


RemediationAction = Literal[
    "refresh_vpn_session", "enable_wifi_adapter", "unlock_account", "reset_mail_sync_profile",
    "clear_temp_and_restart_indexer", "restart_print_spooler",
]


class ProposeInput(StrictModel):
    action: RemediationAction
    target_id: str = SandboxId
    evidence_chunk_ids: list[str] = Field(default_factory=list, max_length=8)
    diagnostic_summary: str = Field(min_length=3, max_length=600)


class ExecuteInput(StrictModel):
    action: RemediationAction
    target_id: str = SandboxId
    parameters: dict[str, str | bool | int] = Field(default_factory=dict)


class VerifyInput(StrictModel):
    check: Literal["vpn_connectivity", "wifi_connectivity", "account_signin", "mail_sync", "performance", "printer_output"]
    target_id: str = SandboxId


class HumanReviewInput(StrictModel):
    reason: str = Field(min_length=3, max_length=600)
    severity: Literal["low", "medium", "high"] = "medium"
    suggested_group: Literal["service_desk", "network_team", "identity_team", "hardware_onsite", "security"] = "service_desk"


class NotifyInput(StrictModel):
    channel: Literal["slack", "teams", "email"]
    recipient: str = Field(max_length=120)
    message: str = Field(max_length=1000)


# ------------------------------------------------------------------ registry
@dataclass
class ToolContext:
    db: Session
    wf: WorkflowRun | None = None
    step: WorkflowStep | None = None
    attempt: int = 1
    idempotency_key: str | None = None
    faults: dict[str, str] = field(default_factory=dict)


@dataclass
class ToolSpec:
    name: str
    description: str
    input_model: type[StrictModel]
    output_schema: dict[str, Any]
    stage: str
    action_class: str | Callable[[StrictModel], str]
    impl: Callable[[ToolContext, Any], dict[str, Any]]
    required_role: str = "employee"
    simulated: bool = True
    side_effect: bool = False
    idempotent: bool = True
    mcp_exposed: bool = False
    integration: str | None = None

    def classify(self, args: StrictModel) -> str:
        return self.action_class(args) if callable(self.action_class) else self.action_class


def _obj(**props: str) -> dict[str, Any]:
    return {"type": "object", "properties": {k: {"type": v} for k, v in props.items()}}


# ------------------------------------------------------------------ implementations
def _resource(ctx: ToolContext, rid: str, kind: str):
    res = sandbox.get(ctx.db, rid)
    if res is None or res.kind != kind:
        raise ToolError("permanent", f"Unknown sandbox {kind} '{rid}'")
    if ctx.wf is not None and res.workflow_id != ctx.wf.id:
        raise ToolError("permanent", f"Sandbox resource '{rid}' does not belong to this workflow")
    return res


def _search_kb(ctx: ToolContext, a: SearchKBInput) -> dict[str, Any]:
    cfg = runtime_settings.get_section(ctx.db, "retrieval")
    return rag.search(ctx.db, a.query, a.top_k or int(cfg["top_k"]), float(cfg["min_relevance"]))


def _device_status(ctx: ToolContext, a: DeviceInput) -> dict[str, Any]:
    if a.device_id.startswith("SBX-PRN-"):
        p = _resource(ctx, a.device_id, "printer").state
        return {"device_id": a.device_id, "kind": "printer", **{k: v for k, v in p.items() if k != "applied_remediations"},
                "sandbox": True}
    s = _resource(ctx, a.device_id, "laptop").state
    return {"kind": "laptop","device_id": a.device_id, "hostname": s.get("hostname"), "os": s["os"], "network": s["network"], "vpn": s["vpn"],
            "wifi": s["wifi"], "performance": s["performance"], "mail": s["mail"], "sandbox": True}


def _account_status(ctx: ToolContext, a: AccountInput) -> dict[str, Any]:
    s = _resource(ctx, a.account_id, "account").state
    return {"account_id": a.account_id, **{k: v for k, v in s.items() if k != "applied_remediations"}, "sandbox": True}


def _network_diag(ctx: ToolContext, a: NetDiagInput) -> dict[str, Any]:
    s = _resource(ctx, a.device_id, "laptop").state
    n = s["network"]

    def chk(name: str, ok: bool, detail: str) -> dict[str, str]:
        return {"name": name, "status": "pass" if ok else "fail", "detail": detail}

    checks = [
        chk("adapter", n["adapter_up"], "Network adapter up" if n["adapter_up"] else "No active network adapter"),
        chk("gateway", n["gateway"], "Default gateway responds" if n["gateway"] else "Gateway unreachable"),
        chk("dns", n["dns"], "Resolves corp.example" if n["dns"] else "DNS resolution failed"),
        chk("internet", n["internet"], "HTTPS probe succeeded" if n["internet"] else "HTTPS probe failed"),
    ]
    if a.target == "vpn":
        v = s["vpn"]
        checks.append(chk("vpn_gateway_reachable", n["internet"], "vpn.corp.example:443 reachable" if n["internet"] else "Gateway unreachable"))
        checks.append(chk("vpn_authentication", v["session"] == "valid", v.get("last_error") or f"Session {v['session']}"))
        checks.append(chk("vpn_tunnel", v["tunnel"] == "up", f"Tunnel {v['tunnel']}"))
    elif a.target == "wifi":
        w = s["wifi"]
        checks.append(chk("wifi_adapter", w["adapter"] == "enabled", f"Adapter {w['adapter']}"))
        checks.append(chk("wifi_association", w["connected"], f"Associated with {w['ssid']}" if w["connected"] else "Not associated"))
    elif a.target == "mail":
        m = s["mail"]
        checks.append(chk("mail_sync", m["sync"] == "ok", m.get("error") or f"Last sync {m['last_sync_minutes']} min ago"))
    failed = [c["name"] for c in checks if c["status"] == "fail"]
    return {"device_id": a.device_id, "target": a.target, "checks": checks, "failed_checks": failed, "sandbox": True}


def _service_status(ctx: ToolContext, a: ServiceInput) -> dict[str, Any]:
    return {"service": a.service, **sandbox.SERVICES[a.service], "checked_via": "sandbox service catalog", "sandbox": True}


def _ticket_dict(t: Ticket) -> dict[str, Any]:
    return {"ticket_id": t.id, "number": t.number, "display_id": f"TKT-{t.number}", "status": t.status, "category": t.category,
            "priority": t.priority}


def _create_ticket(ctx: ToolContext, a: CreateTicketInput) -> dict[str, Any]:
    if ctx.wf is None or not ctx.idempotency_key:
        raise ToolError("permanent", "create_ticket requires a workflow context")
    db = ctx.db
    existing = db.scalar(select(Ticket).where(Ticket.idempotency_key == ctx.idempotency_key))
    fault = ctx.faults.get("ticketing", "none")
    if fault == "permanent":
        raise ToolError("transient", "Ticketing API unavailable: HTTP 503 (injected sustained outage)")
    if fault == "transient" and ctx.attempt == 1:
        if existing is None:
            _insert_ticket(ctx, a)  # the write lands, but the response is lost
        raise ToolError("transient", "Ticketing API timed out after accepting the write (injected); outcome unknown")
    if fault == "transient" and ctx.attempt == 2:
        raise ToolError("transient", "Ticketing API returned HTTP 503 (injected)")
    if existing is not None:
        return {**_ticket_dict(existing), "created": False, "reconciled": True,
                "note": "Existing ticket found by idempotency key; no duplicate created"}
    t = _insert_ticket(ctx, a)
    return {**_ticket_dict(t), "created": True, "reconciled": False}


def _insert_ticket(ctx: ToolContext, a: CreateTicketInput) -> Ticket:
    assert ctx.wf is not None
    number = (ctx.db.scalar(select(func.max(Ticket.number))) or 1000) + 1
    t = Ticket(number=number, title=a.title, description=a.description, category=a.category, priority=a.priority,
               status="open", requester_id=ctx.wf.requester_id, workflow_id=ctx.wf.id,
               idempotency_key=ctx.idempotency_key, origin=ctx.wf.origin)
    ctx.db.add(t)
    ctx.db.flush()
    audit.record(ctx.db, action="ticket.created", resource_type="ticket", resource_id=t.id, actor_role="agent",
                 workflow_id=ctx.wf.id, ticket_id=t.id, details={"number": number, "category": a.category}, origin=ctx.wf.origin)
    return t


def _update_ticket(ctx: ToolContext, a: UpdateTicketInput) -> dict[str, Any]:
    t = ctx.db.get(Ticket, a.ticket_id)
    if t is None or ctx.wf is None or t.workflow_id != ctx.wf.id:
        raise ToolError("permanent", "Ticket not found for this workflow")
    changes: dict[str, Any] = {}
    for f in ("status", "priority", "category", "title", "resolution"):
        v = getattr(a, f)
        if v is not None and getattr(t, f) != v:
            changes[f] = {"from": getattr(t, f), "to": v}
            setattr(t, f, v)
    if a.status == "resolved":
        from app.db import utcnow

        t.resolved_at = utcnow()
    if changes:
        audit.record(ctx.db, action="ticket.updated", resource_type="ticket", resource_id=t.id, actor_role="agent",
                     workflow_id=ctx.wf.id, ticket_id=t.id, details={"changes": changes, "note": a.note}, origin=ctx.wf.origin)
    return {**_ticket_dict(t), "changes": changes}


def _propose(ctx: ToolContext, a: ProposeInput) -> dict[str, Any]:
    rem = sandbox.REMEDIATIONS[a.action]
    _resource(ctx, a.target_id, rem["target_kind"])
    evidence = {e["chunk_id"]: e for e in (ctx.wf.evidence if ctx.wf else [])}
    supported, rejected = [], []
    for cid in a.evidence_chunk_ids:
        e = evidence.get(cid)
        if e is None:
            rejected.append({"chunk_id": cid, "reason": "not in retrieved evidence"})
        elif e.get("trust") == "untrusted_instructions":
            rejected.append({"chunk_id": cid, "reason": "document contains untrusted instructions; excluded from grounding"})
        elif not e.get("above_threshold"):
            rejected.append({"chunk_id": cid, "reason": "below relevance threshold"})
        else:
            supported.append(e)
    decision = policy.decide(ctx.db, rem["action_class"])
    # Grounding needs at least one trusted source about this remediation's topic, not just any relevant text.
    if not any(e.get("category") == rem["category"] for e in supported):
        return {"grounded": False, "action": a.action, "recommendation": None, "rejected_citations": rejected,
                "reason": f"No trusted, relevant knowledge-base article about '{rem['category']}' supports this action."}
    sources = ", ".join(sorted({f"{e['title']} (v{e['version']})" for e in supported}))
    claims = [
        {"text": f"Diagnostics indicate: {a.diagnostic_summary}", "citations": ["tool:diagnostics"], "support": "tool_result"},
        {"text": f"Recommended fix: {rem['title']}.", "citations": [e["chunk_id"] for e in supported], "support": "kb"},
    ]
    return {
        "grounded": True,
        "action": a.action,
        "target_id": a.target_id,
        "recommendation": f"{rem['title']}. {a.diagnostic_summary.rstrip('.')}. Guidance: {sources}.",
        "expected_effect": rem["expected_effect"],
        "claims": claims,
        "citations": [{"chunk_id": e["chunk_id"], "title": e["title"], "document_id": e["document_id"], "version": e["version"]} for e in supported],
        "rejected_citations": rejected,
        "requires_approval": decision.decision == "approval_required",
        "policy_id": decision.policy_id,
    }


def _execute(ctx: ToolContext, a: ExecuteInput) -> dict[str, Any]:
    rem = sandbox.REMEDIATIONS[a.action]
    res = _resource(ctx, a.target_id, rem["target_kind"])
    ineffective = ctx.faults.get("verification", "none") == "ineffective"
    return sandbox.apply_remediation(res, a.action, ctx.idempotency_key or f"adhoc:{a.action}", ineffective)


def _verify(ctx: ToolContext, a: VerifyInput) -> dict[str, Any]:
    kind = {"account_signin": "account", "printer_output": "printer"}.get(a.check, "laptop")
    return sandbox.verify(_resource(ctx, a.target_id, kind), a.check)


def _human_review(ctx: ToolContext, a: HumanReviewInput) -> dict[str, Any]:
    return {"review_requested": True, "reason": a.reason, "severity": a.severity, "suggested_group": a.suggested_group}


def _notify(ctx: ToolContext, a: NotifyInput) -> dict[str, Any]:
    raise ToolError("permanent", f"Integration not configured: {a.channel}. No notification was sent.")


REGISTRY: dict[str, ToolSpec] = {
    s.name: s
    for s in [
        ToolSpec("search_knowledge_base", "Retrieve relevant knowledge-base chunks with source, version and relevance.",
                 SearchKBInput, _obj(results="array", backend="string", min_relevance="number"), "retrieving", "kb_read",
                 _search_kb, simulated=False, mcp_exposed=True),
        ToolSpec("get_device_status", "Read the sandbox laptop's network, VPN, Wi-Fi, mail and performance state.",
                 DeviceInput, _obj(device_id="string", network="object", vpn="object", wifi="object", performance="object"),
                 "diagnosing", "device_read", _device_status, mcp_exposed=True),
        ToolSpec("get_account_status", "Read the sandbox directory account's lock state.", AccountInput,
                 _obj(account_id="string", locked="boolean", failed_attempts="integer"), "diagnosing", "device_read",
                 _account_status, mcp_exposed=True),
        ToolSpec("run_network_diagnostics", "Run allowlisted read-only connectivity checks on the sandbox laptop.",
                 NetDiagInput, _obj(checks="array", failed_checks="array"), "diagnosing", "diagnostic_readonly",
                 _network_diag, mcp_exposed=True),
        ToolSpec("check_service_status", "Check a backend service's status in the sandbox service catalog.", ServiceInput,
                 _obj(service="string", status="string"), "diagnosing", "diagnostic_readonly", _service_status, mcp_exposed=True),
        ToolSpec("create_ticket", "Create the support ticket for this workflow (idempotent per workflow).", CreateTicketInput,
                 _obj(ticket_id="string", display_id="string", created="boolean", reconciled="boolean"), "classifying",
                 "ticket_write", _create_ticket, simulated=False, side_effect=True),
        ToolSpec("update_ticket", "Update status, priority or resolution of this workflow's ticket.", UpdateTicketInput,
                 _obj(ticket_id="string", changes="object"), "verifying", "ticket_write", _update_ticket, simulated=False,
                 side_effect=True),
        ToolSpec("propose_remediation", "Produce a fix recommendation grounded in trusted retrieved evidence.", ProposeInput,
                 _obj(grounded="boolean", recommendation="string", citations="array", requires_approval="boolean"),
                 "diagnosing", "recommendation", _propose, simulated=False),
        ToolSpec("execute_sandbox_remediation", "Apply a catalogued remediation to a sandbox resource.", ExecuteInput,
                 _obj(applied="boolean", changed_fields="array"), "executing",
                 lambda a: sandbox.REMEDIATIONS[a.action]["action_class"], _execute, required_role="engineer",
                 side_effect=True),
        ToolSpec("verify_resolution", "Re-run a diagnostic to verify whether the issue is resolved.", VerifyInput,
                 _obj(verified="boolean", method="string", observations="object"), "verifying", "diagnostic_readonly", _verify),
        ToolSpec("request_human_review", "Pause automation and route the case to a human (always permitted).",
                 HumanReviewInput, _obj(review_requested="boolean"), "awaiting_human_review", "human_review_request",
                 _human_review, simulated=False),
        ToolSpec("send_external_notification", "Send a Slack / Teams / email notification (integration not configured).",
                 NotifyInput, _obj(sent="boolean"), "executing", "external_notification", _notify, required_role="engineer",
                 side_effect=True, integration="slack/teams/email"),
    ]
}


# ------------------------------------------------------------------ execution pipeline
@dataclass
class ToolOutcome:
    status: str  # success | needs_approval | blocked | error
    tool: str
    args: dict[str, Any] = field(default_factory=dict)
    result: dict[str, Any] | None = None
    error: str | None = None
    error_kind: str | None = None
    decision: policy.PolicyDecision | None = None
    tool_call_id: str | None = None
    duration_ms: int = 0
    transport: str = "in_process"


def action_hash(workflow_id: str, step_key: str, tool: str, args: dict[str, Any], version: int) -> str:
    payload = json.dumps({"wf": workflow_id, "step": step_key, "tool": tool, "args": args, "v": version}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def validate_args(name: str, raw_args: dict[str, Any]) -> dict[str, Any]:
    spec = REGISTRY[name]
    return spec.input_model.model_validate(raw_args).model_dump(exclude_none=True)


def _record(ctx: ToolContext, name: str, args: dict[str, Any], status: str, *, result=None, error=None, error_kind=None,
            duration_ms=0, transport="in_process", simulated=True, decision: str | None = None) -> ToolCall:
    tc = ToolCall(
        workflow_id=ctx.wf.id if ctx.wf else None,
        step_id=ctx.step.id if ctx.step else None,
        tool_name=name,
        arguments=sanitize(args),
        result=sanitize(result) if result is not None else None,
        status=status,
        error=error,
        error_kind=error_kind,
        attempt=ctx.attempt,
        duration_ms=duration_ms,
        transport=transport,
        simulated=simulated,
        policy_decision=decision,
        idempotency_key=ctx.idempotency_key,
    )
    ctx.db.add(tc)
    ctx.db.flush()
    return tc


def run_tool(ctx: ToolContext, name: str, raw_args: dict[str, Any], approval: ApprovalRequest | None = None) -> ToolOutcome:
    origin = ctx.wf.origin if ctx.wf else "live"
    spec = REGISTRY.get(name)
    if spec is None:
        d = policy.decide(ctx.db, "unclassified")
        tc = _record(ctx, name, raw_args, "blocked", error="Unknown tool", error_kind="policy", decision=d.decision)
        audit.record(ctx.db, action="tool.blocked", resource_type="tool", resource_id=name, outcome="denied", actor_role="agent",
                     workflow_id=ctx.wf.id if ctx.wf else None, details={"policy": d.policy_id, "reason": "unknown tool"}, origin=origin)
        return ToolOutcome("blocked", name, raw_args, error="Unknown tool is not in the registry", error_kind="policy",
                           decision=d, tool_call_id=tc.id)
    try:
        model = spec.input_model.model_validate(raw_args)
    except ValidationError as exc:
        errs = [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]
        tc = _record(ctx, name, raw_args, "error", error=json.dumps(errs)[:1000], error_kind="validation")
        return ToolOutcome("error", name, raw_args, error=f"Invalid arguments: {errs}", error_kind="validation", tool_call_id=tc.id)
    args = model.model_dump(exclude_none=True)
    d = policy.decide(ctx.db, spec.classify(model))

    if d.decision == "unavailable":
        tc = _record(ctx, name, args, "blocked", error=d.description, error_kind="policy", decision=d.decision)
        audit.record(ctx.db, action="tool.blocked", resource_type="tool", resource_id=name, outcome="denied", actor_role="agent",
                     workflow_id=ctx.wf.id if ctx.wf else None, details={"policy": d.policy_id, "args": args}, origin=origin)
        return ToolOutcome("blocked", name, args, error=f"Blocked by {d.policy_id}: {d.description}", error_kind="policy",
                           decision=d, tool_call_id=tc.id)

    if d.decision == "approval_required":
        if approval is None or approval.status not in ("approved", "executing"):
            return ToolOutcome("needs_approval", name, args, decision=d)
        expected = action_hash(approval.workflow_id, ctx.step.step_key if ctx.step else "", name, args, approval.action_version)
        if expected != approval.params_hash:
            return ToolOutcome("needs_approval", name, args, decision=d, error="Approved parameters do not match this action")

    transport = "in_process"
    if spec.mcp_exposed and runtime_settings.get_section(ctx.db, "demo").get("tool_transport") == "mcp":
        transport = "mcp"
    started = time.perf_counter()
    try:
        if transport == "mcp":
            from app import mcp_client

            timeout = float(runtime_settings.get_section(ctx.db, "execution")["tool_timeout_seconds"])
            result = asyncio.run(mcp_client.call_tool(name, args, timeout))
        else:
            result = spec.impl(ctx, model)
    except ToolError as exc:
        ms = int((time.perf_counter() - started) * 1000)
        tc = _record(ctx, name, args, "timeout" if exc.kind == "timeout" else "error", error=exc.message, error_kind=exc.kind,
                     duration_ms=ms, transport=transport, simulated=spec.simulated, decision=d.decision)
        return ToolOutcome("error", name, args, error=exc.message, error_kind=exc.kind, decision=d, tool_call_id=tc.id,
                           duration_ms=ms, transport=transport)
    except Exception as exc:  # unexpected failures are permanent: never blindly retried
        ms = int((time.perf_counter() - started) * 1000)
        msg = f"{type(exc).__name__}: {str(exc)[:300]}"
        tc = _record(ctx, name, args, "error", error=msg, error_kind="permanent", duration_ms=ms, transport=transport,
                     simulated=spec.simulated, decision=d.decision)
        return ToolOutcome("error", name, args, error=msg, error_kind="permanent", decision=d, tool_call_id=tc.id,
                           duration_ms=ms, transport=transport)
    ms = int((time.perf_counter() - started) * 1000)
    tc = _record(ctx, name, args, "success", result=result, duration_ms=ms, transport=transport, simulated=spec.simulated,
                 decision=d.decision)
    if spec.side_effect:
        audit.record(ctx.db, action="tool.executed", resource_type="tool", resource_id=name, actor_role="agent",
                     workflow_id=ctx.wf.id if ctx.wf else None, ticket_id=ctx.wf.ticket_id if ctx.wf else None,
                     details={"args": args, "approval_id": approval.id if approval else None, "transport": transport},
                     origin=origin)
    return ToolOutcome("success", name, args, result=result, decision=d, tool_call_id=tc.id, duration_ms=ms, transport=transport)


def describe_registry(db: Session) -> list[dict[str, Any]]:
    out = []
    for s in REGISTRY.values():
        if callable(s.action_class):
            classes = sorted({r["action_class"] for r in sandbox.REMEDIATIONS.values()})
        else:
            classes = [s.action_class]
        decisions = [policy.decide(db, c) for c in classes]
        out.append({
            "name": s.name,
            "description": s.description,
            "input_schema": s.input_model.model_json_schema(),
            "output_schema": s.output_schema,
            "stage": s.stage,
            "action_classes": classes,
            "policies": [d.as_dict() for d in decisions],
            "risk_level": max((d.risk_level for d in decisions), key=["low", "medium", "high", "critical"].index),
            "required_role": s.required_role,
            "execution_mode": ("external integration (not configured)" if s.integration
                               else "sandbox (simulated IT environment)" if s.simulated else "real application logic"),
            "side_effect": s.side_effect,
            "idempotent": s.idempotent,
            "mcp_exposed": s.mcp_exposed,
            "integration": s.integration,
        })
    return out
