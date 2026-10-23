"""Workflow engine: a persisted state machine advanced one checkpoint at a time.

States
  received -> classifying -> retrieving -> planning -> diagnosing -> awaiting_approval -> executing -> verifying -> completed
Branches
  awaiting_user_input | awaiting_human_review | escalated | failed | cancelled | blocked

Each loop iteration of advance() runs one node or one plan step inside its own transaction,
so every commit is a durable checkpoint. A refreshed browser reads the persisted state; a restarted
backend re-queues interrupted jobs (worker.recover) and resumes from the last checkpoint. Side-effecting
steps carry idempotency keys and approvals are claimed with conditional UPDATEs, so a replayed step
reconciles instead of repeating.
"""

from __future__ import annotations

import time
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app import agent, audit, events, llm, policy, runtime_settings, sandbox
from app.db import session_scope, utcnow
from app.errors import AppError, bad_request, conflict, forbidden
from app.models import (
    ApprovalDecision, ApprovalRequest, Conversation, Job, Message, Ticket, ToolCall, User, WorkflowRun, WorkflowStep,
)
from app.security import redact_text
from app.tools import REGISTRY, ToolContext, ToolOutcome, action_hash, run_tool, validate_args

TERMINAL = {"completed", "escalated", "failed", "cancelled", "blocked"}
WAITING = {"awaiting_approval", "awaiting_user_input", "awaiting_human_review"}
STEP_STAGES = {"diagnosing", "executing", "verifying"}
TICKET_STATUS_FOR = {
    "awaiting_approval": "pending_approval",
    "awaiting_user_input": "waiting_on_user",
    "awaiting_human_review": "in_progress",
    "diagnosing": "in_progress",
}

STOP, CONTINUE = "stop", "continue"


class _Retry(Exception):
    def __init__(self, delay: float) -> None:
        self.delay = delay


# ================================================================== helpers
def transition(db: Session, wf: WorkflowRun, status: str, summary: str, data: dict[str, Any] | None = None) -> None:
    old = wf.status
    wf.status = status
    wf.version += 1
    if status in TERMINAL:
        wf.completed_at = utcnow()
    events.emit(db, wf, "stage_changed", summary, {"from": old, "to": status, "version": wf.version, **(data or {})})


def set_state(wf: WorkflowRun, **kv: Any) -> None:
    wf.state = {**(wf.state or {}), **kv}


def add_message(db: Session, wf: WorkflowRun, role: str, content: str, kind: str = "text", meta: dict | None = None,
                author_id: str | None = None) -> Message:
    m = Message(conversation_id=wf.conversation_id, author_role=role, author_id=author_id, kind=kind, content=content,
                meta=meta or {})
    db.add(m)
    db.flush()
    return m


def enqueue(db: Session, workflow_id: str, delay: float = 0.0, dedupe_key: str | None = None) -> None:
    if dedupe_key and db.scalar(select(Job.id).where(Job.dedupe_key == dedupe_key)):
        return
    pending = db.scalar(select(Job.id).where(Job.workflow_id == workflow_id, Job.kind == "advance", Job.status == "queued"))
    if pending and delay == 0:
        return
    from datetime import timedelta

    db.add(Job(workflow_id=workflow_id, kind="advance", run_after=utcnow() + timedelta(seconds=delay), dedupe_key=dedupe_key))


def ctx_for(db: Session, wf: WorkflowRun, step: WorkflowStep | None = None, attempt: int = 1, key: str | None = None) -> ToolContext:
    return ToolContext(db=db, wf=wf, step=step, attempt=attempt, idempotency_key=key, faults=(wf.state or {}).get("faults", {}))


def _tool_event(db: Session, wf: WorkflowRun, out: ToolOutcome, step: WorkflowStep | None = None) -> None:
    spec = REGISTRY.get(out.tool)
    sim = bool(spec and spec.simulated)
    label = {"success": "completed", "error": "failed", "blocked": "blocked by policy", "needs_approval": "requires approval"}[out.status]
    events.emit(db, wf, "tool_call", f"{out.tool} {label}" + (f" ({out.error})" if out.error and out.status != "needs_approval" else ""),
                {"tool": out.tool, "status": out.status, "args": out.args, "tool_call_id": out.tool_call_id,
                 "duration_ms": out.duration_ms, "transport": out.transport, "step_key": step.step_key if step else None,
                 "error_kind": out.error_kind, "policy": out.decision.policy_id if out.decision else None},
                simulated=sim)


def _account_llm(wf: WorkflowRun, calls: list[llm.LLMResult]) -> None:
    for c in calls:
        wf.input_tokens += c.input_tokens
        wf.output_tokens += c.output_tokens
        wf.cost_usd = round(wf.cost_usd + c.cost_usd, 6)


def _sync_ticket(db: Session, wf: WorkflowRun, status: str, **extra: Any) -> None:
    """Keep the ticket status in step with the workflow, via the update_ticket tool (so it is traced)."""
    if not wf.ticket_id:
        return
    t = db.get(Ticket, wf.ticket_id)
    if t is None or (t.status == status and not extra):
        return
    out = run_tool(ctx_for(db, wf, key=f"ticket-update:{wf.id}:{wf.version}"), "update_ticket",
                   {"ticket_id": wf.ticket_id, "status": status, **extra})
    _tool_event(db, wf, out)


def _schedule_retry(db: Session, wf: WorkflowRun, key: str, out: ToolOutcome, resume_status: str) -> None:
    cfg = runtime_settings.get_section(db, "retry")
    retries = dict((wf.state or {}).get("retries", {}))
    n = retries.get(key, 0) + 1
    retries[key] = n
    set_state(wf, retries=retries)
    if n >= int(cfg["max_attempts"]):
        _fail(db, wf, "retries_exhausted", f"{out.tool} failed after {n} attempts: {out.error}", retryable=True,
              resume_status=resume_status, retry_key=key)
        raise _Retry(-1)
    delay = min(float(cfg["base_backoff_seconds"]) * (2 ** (n - 1)), float(cfg["max_backoff_seconds"]))
    wf.retry_count += 1
    events.emit(db, wf, "retry_scheduled", f"Transient failure in {out.tool}; retry {n + 1} of {cfg['max_attempts']} in {delay:.1f}s",
                {"tool": out.tool, "error": out.error, "attempt": n, "next_attempt": n + 1, "delay_seconds": delay})
    raise _Retry(delay)


def _fail(db: Session, wf: WorkflowRun, code: str, message: str, retryable: bool = False, resume_status: str | None = None,
          retry_key: str | None = None) -> None:
    wf.error = {"code": code, "message": message, "retryable": retryable, "resume_status": resume_status,
                "retry_key": retry_key, "at": utcnow().isoformat()}
    transition(db, wf, "failed", f"Workflow failed: {message}", {"error_code": code})
    audit.record(db, action="workflow.failed", resource_type="workflow", resource_id=wf.id, outcome="failure",
                 actor_role="agent", workflow_id=wf.id, ticket_id=wf.ticket_id, details=wf.error, origin=wf.origin)
    note = " Your request is saved and a support engineer has been notified." if wf.origin != "eval" else ""
    add_message(db, wf, "system", f"Automation stopped: {message}.{note}", kind="notice")
    events.notify(db, events.staff_ids(db), "workflow_failed", f"Workflow failed: {wf.original_request[:60]}", message,
                  f"/workflows/{wf.id}")


def _request_review(db: Session, wf: WorkflowRun, reason: str, group: str = "service_desk", severity: str = "medium") -> str:
    out = run_tool(ctx_for(db, wf, key=f"review:{wf.id}:{wf.version}"), "request_human_review",
                   {"reason": reason[:600], "severity": severity, "suggested_group": group})
    _tool_event(db, wf, out)
    set_state(wf, review={"reason": reason, "group": group, "severity": severity, "requested_at": utcnow().isoformat()})
    transition(db, wf, "awaiting_human_review", f"Routed to human review: {reason}", {"group": group})
    _sync_ticket(db, wf, "in_progress")
    add_message(db, wf, "assistant", f"I've routed this to a support engineer for review. Reason: {reason}", kind="notice")
    events.notify(db, events.staff_ids(db), "human_review", f"Review needed: {wf.original_request[:60]}", reason, f"/workflows/{wf.id}")
    return STOP


def _combined_request(wf: WorkflowRun) -> str:
    extra = [c["text"] for c in (wf.state or {}).get("clarifications", [])]
    return "\n".join([wf.original_request, *extra])


def _steps(db: Session, wf: WorkflowRun) -> list[WorkflowStep]:
    return list(db.scalars(select(WorkflowStep).where(WorkflowStep.workflow_id == wf.id).order_by(WorkflowStep.position)).all())


# ================================================================== nodes
def h_received(db: Session, wf: WorkflowRun) -> str:
    transition(db, wf, "classifying", "Request accepted; classifying")
    return CONTINUE


def h_classifying(db: Session, wf: WorkflowRun) -> str:
    st = wf.state or {}
    if "classification" not in st:
        text = _combined_request(wf)
        if wf.mode == "live":
            model = llm.models(db)["classifier"]
            c, calls = agent.classify_live(text, model)
            _account_llm(wf, calls)
        else:
            c = agent.classify_demo(text)
        set_state(wf, classification=c.as_dict())
        wf.category, wf.priority = c.category, c.priority
        events.emit(db, wf, "classified", f"Classified as {c.category} / {c.priority} priority ({c.method})",
                    {"classification": c.as_dict()}, simulated=wf.mode == "demo")
    c = wf.state["classification"]
    if c["category"] in sandbox.FIXTURES and "sandbox" not in wf.state:
        requester = db.get(User, wf.requester_id)
        info = sandbox.prime(db, wf, c["category"], requester.email if requester else "user@example")
        events.emit(db, wf, "sandbox_primed", f"Sandbox fixture applied: {info['fixture']}", info, simulated=True)

    if not wf.ticket_id:
        key = "create_ticket"
        attempt = (wf.state.get("retries", {}).get(key, 0)) + 1
        out = run_tool(ctx_for(db, wf, attempt=attempt, key=f"ticket:{wf.id}"), "create_ticket", {
            "title": c["title"][:200], "description": redact_text(wf.original_request)[0][:4000],
            "category": c["category"] if c["category"] in ("vpn", "wifi", "account", "email", "printer", "performance",
                                                           "unclassified", "security_policy") else "other",
            "priority": c["priority"],
        })
        _tool_event(db, wf, out)
        if out.status == "success":
            wf.ticket_id = out.result["ticket_id"]
            t = db.get(Ticket, wf.ticket_id)
            events.emit(db, wf, "ticket_linked",
                        f"Ticket {out.result['display_id']} {'reconciled (existing)' if out.result.get('reconciled') else 'created'}",
                        out.result)
        elif out.error_kind in ("transient", "timeout"):
            _schedule_retry(db, wf, key, out, "classifying")
        else:
            _fail(db, wf, "ticket_creation_failed", out.error or "create_ticket failed")
            return STOP
    elif st.get("reclassified"):
        t = db.get(Ticket, wf.ticket_id)
        if t and t.category != c["category"]:
            _sync_ticket(db, wf, "in_progress", category=c["category"] if c["category"] != "other" else "other",
                         title=c["title"][:200], priority=c["priority"])
        set_state(wf, reclassified=False)

    if c["unsafe"]:
        return _block(db, wf, c["unsafe"])
    if c["category"] == "unclassified":
        return _ask_clarification(db, wf, c.get("clarifying_question") or agent.DEFAULT_CLARIFICATION)
    transition(db, wf, "retrieving", "Retrieving knowledge-base evidence")
    return CONTINUE


def _block(db: Session, wf: WorkflowRun, unsafe: list[dict[str, str]]) -> str:
    decisions = [policy.decide(db, u["action_class"]) for u in unsafe]
    for u, d in zip(unsafe, decisions):
        audit.record(db, action="request.blocked", resource_type="workflow", resource_id=wf.id, outcome="denied",
                     actor=db.get(User, wf.requester_id), workflow_id=wf.id, ticket_id=wf.ticket_id,
                     details={"policy": d.policy_id, "action_class": u["action_class"], "request": wf.original_request[:300]},
                     origin=wf.origin)
        events.emit(db, wf, "policy_denied", f"{d.policy_id}: {d.description} — {d.decision}", d.as_dict())
    reasons = " ".join(sorted({u["reason"] for u in unsafe}))
    add_message(db, wf, "assistant",
                f"I can't do that. {reasons} This attempt has been recorded in the audit log. "
                "If you need help with a specific account or device, describe the problem and I'll start a normal support workflow.",
                kind="notice", meta={"policies": [d.policy_id for d in decisions]})
    _sync_ticket(db, wf, "closed", resolution=f"Blocked by policy ({', '.join(d.policy_id for d in decisions)}). No action taken.")
    transition(db, wf, "blocked", "Request blocked by policy; no tools executed", {"policies": [d.policy_id for d in decisions]})
    events.notify(db, events.staff_ids(db, ("admin",)), "policy_denied", "Unsafe request blocked", wf.original_request[:120],
                  f"/workflows/{wf.id}")
    return STOP


def _ask_clarification(db: Session, wf: WorkflowRun, question: str) -> str:
    rounds = (wf.state or {}).get("clarification_rounds", 0)
    limit = int(runtime_settings.get_section(db, "execution")["max_clarifications"])
    if rounds >= limit:
        return _request_review(db, wf, f"Issue still unclear after {rounds} clarification attempts")
    set_state(wf, clarification_rounds=rounds + 1,
              pending_question={"kind": "clarification", "question": question, "asked_at": utcnow().isoformat()})
    add_message(db, wf, "assistant", question, kind="clarification",
                meta={"missing": wf.state["classification"].get("missing_information", []),
                      "suggestions": ["The VPN on my laptop", "Office Wi-Fi", "My email", "The printer", "I'm locked out of my account"]})
    _sync_ticket(db, wf, "waiting_on_user")
    transition(db, wf, "awaiting_user_input", "Waiting for clarification from the requester")
    events.notify(db, [wf.requester_id], "clarification", "We need a bit more detail", question[:140], f"/support?wf={wf.id}")
    return STOP


def h_retrieving(db: Session, wf: WorkflowRun) -> str:
    c = wf.state["classification"]
    query = f"{_combined_request(wf)} {c['title']}"
    out = run_tool(ctx_for(db, wf, key=f"retrieve:{wf.id}"), "search_knowledge_base", {"query": query[:500]})
    _tool_event(db, wf, out)
    if out.status != "success":
        if out.error_kind in ("transient", "timeout"):
            _schedule_retry(db, wf, "retrieve", out, "retrieving")
        return _request_review(db, wf, f"Knowledge retrieval failed: {out.error}")
    results = out.result["results"]
    wf.evidence = results
    events.emit(db, wf, "evidence_retrieved",
                f"{sum(r['above_threshold'] for r in results)} of {len(results)} chunks above relevance threshold "
                f"{out.result['min_relevance']} ({out.result['backend']})",
                {"backend": out.result["backend_label"], "results": [{k: r[k] for k in ("chunk_id", "title", "relevance", "trust", "above_threshold")} for r in results]})
    for r in results:
        if r["trust"] == "untrusted_instructions":
            events.emit(db, wf, "untrusted_content",
                        f"'{r['title']}' contains instruction-like text aimed at the agent; treated as untrusted data and excluded from grounding. Policy unchanged.",
                        {"chunk_id": r["chunk_id"], "document_id": r["document_id"]})
            audit.record(db, action="kb.untrusted_instructions_ignored", resource_type="knowledge_document",
                         resource_id=r["document_id"], actor_role="agent", workflow_id=wf.id, ticket_id=wf.ticket_id,
                         details={"chunk_id": r["chunk_id"]}, origin=wf.origin)
    trusted = [r for r in results if r["above_threshold"] and r["trust"] == "standard"]
    if not trusted:
        events.emit(db, wf, "insufficient_evidence", "No trusted evidence above the relevance threshold")
        return _request_review(db, wf, "No trusted knowledge-base evidence above the relevance threshold; not inventing a fix")
    transition(db, wf, "planning", "Planning diagnostics")
    return CONTINUE


def h_planning(db: Session, wf: WorkflowRun) -> str:
    c = wf.state["classification"]
    sb = wf.state.get("sandbox")
    if not sb:
        return _request_review(db, wf, f"No sandbox diagnostics available for category '{c['category']}'")
    if wf.mode == "live":
        steps, summary, calls = agent.plan_live(c["category"], sb, _combined_request(wf), wf.evidence, llm.models(db)["planner"])
        _account_llm(wf, calls)
    else:
        steps, summary = agent.plan_demo(c["category"], sb)
    if not steps:
        return _request_review(db, wf, f"No diagnostic plan available for category '{c['category']}'")
    max_steps = int(runtime_settings.get_section(db, "execution")["max_steps"])
    if len(steps) + 3 > max_steps:
        _fail(db, wf, "plan_over_budget", f"Plan has {len(steps)} steps; budget is {max_steps}")
        return STOP
    for i, s in enumerate(steps):
        args = validate_args(s.tool, s.args)  # schema-valid before persistence
        db.add(WorkflowStep(workflow_id=wf.id, step_key=s.key, position=i, title=s.title, tool=s.tool, arguments=args,
                            depends_on=s.depends_on, rationale=s.rationale))
    wf.plan_summary = summary
    set_state(wf, plan_revision=1)
    db.flush()
    events.emit(db, wf, "plan_created", summary,
                {"revision": 1, "steps": [{"key": s.key, "title": s.title, "tool": s.tool, "depends_on": s.depends_on} for s in steps]},
                simulated=wf.mode == "demo")
    transition(db, wf, "diagnosing", "Running diagnostics")
    return CONTINUE


def h_steps(db: Session, wf: WorkflowRun) -> str:
    steps = _steps(db, wf)
    done = {s.step_key for s in steps if s.status in ("done", "skipped")}
    nxt = next((s for s in steps if s.status in ("pending", "running", "awaiting_approval") and set(s.depends_on) <= done), None)
    if nxt is None:
        if any(s.status == "pending" for s in steps):
            _fail(db, wf, "plan_deadlock", "Plan has steps whose dependencies cannot be satisfied")
            return STOP
        if "diagnosis" not in (wf.state or {}):
            return _diagnose(db, wf, steps)
        return _request_review(db, wf, "Plan finished without a verified outcome")
    stage = REGISTRY[nxt.tool].stage if nxt.tool in REGISTRY else "executing"
    stage = stage if stage in STEP_STAGES else "diagnosing"
    if wf.status != stage:
        transition(db, wf, stage, f"{stage.capitalize()}: {nxt.title}")
    return _run_step(db, wf, nxt)


def _latest_approval(db: Session, step: WorkflowStep) -> ApprovalRequest | None:
    return db.scalar(select(ApprovalRequest).where(ApprovalRequest.step_id == step.id, ApprovalRequest.status != "invalidated")
                     .order_by(ApprovalRequest.action_version.desc()))


def _run_step(db: Session, wf: WorkflowRun, step: WorkflowStep) -> str:
    approval = _latest_approval(db, step)
    if approval is not None and approval.status == "rejected":
        step.status = "skipped"
        step.result_summary = f"Rejected by reviewer: {approval.decision_reason}"
        events.emit(db, wf, "step_skipped", f"{step.title} not executed: approval rejected", {"approval_id": approval.id})
        _skip_dependents(db, wf, step)
        return _request_review(db, wf, f"Reviewer rejected '{approval.action_summary}': {approval.decision_reason}")
    if approval is not None and approval.status == "approved":
        claimed = db.execute(update(ApprovalRequest).where(ApprovalRequest.id == approval.id, ApprovalRequest.status == "approved")
                             .values(status="executing")).rowcount
        db.refresh(approval)
        if claimed != 1 and approval.status != "executing":
            return STOP
    if approval is not None and approval.status == "executed":
        prior = db.scalar(select(ToolCall).where(ToolCall.idempotency_key == f"approval:{approval.id}", ToolCall.status == "success"))
        step.status = "done"
        step.result_summary = "Reconciled with prior execution"
        return _after_success(db, wf, step, prior.result if prior else {})

    key = f"approval:{approval.id}" if approval is not None else f"step:{step.id}"
    step.status = "running"
    step.started_at = step.started_at or utcnow()
    step.attempts += 1
    out = run_tool(ctx_for(db, wf, step, attempt=step.attempts, key=key), step.tool, step.arguments, approval)
    _tool_event(db, wf, out, step)

    if out.status == "needs_approval":
        if approval is not None and approval.status in ("pending", "info_requested"):
            step.status = "awaiting_approval"
            step.attempts -= 1
            transition(db, wf, "awaiting_approval", f"Waiting for approval: {approval.action_summary}")
            return STOP
        if approval is not None and approval.status in ("approved", "executing"):
            approval.status = "invalidated"
            events.emit(db, wf, "approval_invalidated", "Approval invalidated: action parameters changed after approval",
                        {"approval_id": approval.id})
        step.attempts -= 1
        return _create_approval(db, wf, step, out)
    if out.status == "blocked":
        step.status = "blocked"
        step.result_summary = out.error
        _skip_dependents(db, wf, step)
        return _request_review(db, wf, f"Step blocked by policy: {out.error}", severity="high")
    if out.status == "error":
        spec = REGISTRY.get(step.tool)
        if out.error_kind in ("transient", "timeout") and spec and (spec.idempotent or not spec.side_effect):
            step.status = "pending"
            _schedule_retry(db, wf, f"step:{step.step_key}", out, wf.status)
        step.status = "failed"
        step.finished_at = utcnow()
        step.result_summary = out.error
        _fail(db, wf, f"{step.tool}_failed", out.error or "tool failed", retryable=bool(spec and spec.idempotent),
              resume_status=wf.status, retry_key=f"step:{step.step_key}")
        return STOP

    step.status = "done"
    step.finished_at = utcnow()
    if approval is not None:
        approval.status = "executed"
        approval.executed_at = utcnow()
    return _after_success(db, wf, step, out.result or {}, approval)


def _skip_dependents(db: Session, wf: WorkflowRun, step: WorkflowStep) -> None:
    blocked = {step.step_key}
    for s in _steps(db, wf):
        if s.status == "pending" and set(s.depends_on) & blocked:
            s.status = "skipped"
            s.result_summary = f"Skipped: depends on {step.step_key}"
            blocked.add(s.step_key)


def _create_approval(db: Session, wf: WorkflowRun, step: WorkflowStep, out: ToolOutcome) -> str:
    d = out.decision
    assert d is not None
    prior = db.scalar(select(ApprovalRequest).where(ApprovalRequest.step_id == step.id).order_by(ApprovalRequest.action_version.desc()))
    version = (prior.action_version + 1) if prior else 1
    rem = sandbox.REMEDIATIONS.get(out.args.get("action", ""), {})
    trusted = sorted([e for e in wf.evidence if e.get("trust") == "standard" and e.get("above_threshold")],
                     key=lambda e: (e.get("category") != rem.get("category"), e.get("retrieval") != "fix_guidance", -e["relevance"]))[:3]
    diag = (wf.state or {}).get("diagnosis", {})
    apr = ApprovalRequest(
        workflow_id=wf.id, step_id=step.id, ticket_id=wf.ticket_id, requester_id=wf.requester_id, tool_name=step.tool,
        action=out.args.get("action", step.tool), action_summary=rem.get("title", step.title),
        target_resource=out.args.get("target_id", "n/a"), parameters=out.args,
        params_hash=action_hash(wf.id, step.step_key, step.tool, out.args, version), action_version=version,
        risk_level=d.risk_level, policy_id=d.policy_id, policy_text=d.description, approver_roles=d.approver_roles,
        reason_required=d.reason_required,
        evidence=[{"kind": "diagnosis", "text": diag.get("finding", ""), "verifier": diag.get("verifier", {})}]
                 + [{"kind": "kb", "chunk_id": e["chunk_id"], "document_id": e["document_id"], "title": e["title"],
                     "version": e["version"], "relevance": e["relevance"], "snippet": e["snippet"][:300]} for e in trusted],
        expected_effect=rem.get("expected_effect", "See tool description"), origin=wf.origin,
    )
    db.add(apr)
    db.flush()
    step.status = "awaiting_approval"
    events.emit(db, wf, "approval_requested", f"Approval required ({d.policy_id}, {d.risk_level} risk): {apr.action_summary}",
                {"approval_id": apr.id, "params_hash": apr.params_hash, "action_version": version, "approver_roles": d.approver_roles})
    audit.record(db, action="approval.requested", resource_type="approval", resource_id=apr.id, actor_role="agent",
                 workflow_id=wf.id, ticket_id=wf.ticket_id, details={"tool": step.tool, "args": out.args, "policy": d.policy_id},
                 origin=wf.origin)
    _sync_ticket(db, wf, "pending_approval")
    transition(db, wf, "awaiting_approval", f"Waiting for approval: {apr.action_summary}", {"approval_id": apr.id})
    add_message(db, wf, "assistant",
                f"The recommended fix needs approval from a support engineer before it runs ({d.policy_id}). I'll continue once it's reviewed.",
                kind="notice")
    events.notify(db, events.staff_ids(db), "approval_requested", f"Approval needed: {apr.action_summary}",
                  f"{d.risk_level} risk · {d.policy_id}", "/approvals")
    return STOP


def _diagnose(db: Session, wf: WorkflowRun, steps: list[WorkflowStep]) -> str:
    sb = wf.state["sandbox"]
    calls = db.scalars(select(ToolCall).where(ToolCall.workflow_id == wf.id, ToolCall.status == "success",
                                              ToolCall.tool_name.in_(agent.DIAGNOSTIC_TOOLS)).order_by(ToolCall.created_at)).all()
    results = [(c.tool_name, c.result or {}) for c in calls]
    obs = agent.observations(results)
    if wf.mode == "live":
        dx, llm_calls = agent.diagnose_live(wf.category or "other", results, sb, llm.models(db)["planner"])
        _account_llm(wf, llm_calls)
    else:
        dx = agent.diagnose_demo(wf.category or "other", obs, sb)
    ok, why = agent.verify_diagnosis(dx, obs, sb)
    set_state(wf, diagnosis={"finding": dx.finding, "action": dx.action, "target_id": dx.target_id, "human_review": dx.human_review,
                             "reason": dx.reason, "method": dx.method, "verifier": {"supported": ok, "detail": why}})
    events.emit(db, wf, "diagnosis", dx.finding, {"action": dx.action, "method": dx.method}, simulated=wf.mode == "demo")
    events.emit(db, wf, "verifier_check", why, {"supported": ok})
    if not ok:
        return _request_review(db, wf, why, severity="high")
    if dx.human_review or dx.action is None:
        return _request_review(db, wf, dx.reason or dx.finding, group=dx.review_group)

    rem = sandbox.REMEDIATIONS[dx.action]
    topic = rem["category"]
    # Targeted retrieval: look up guidance for the specific fix, so citations point at the section that describes it.
    out = run_tool(ctx_for(db, wf, key=f"retrieve-fix:{wf.id}"), "search_knowledge_base",
                   {"query": f"{rem['title']}. {dx.finding}"[:500], "top_k": 3})
    _tool_event(db, wf, out)
    fix_ids: set[str] = set()
    if out.status == "success":
        known = {e["chunk_id"] for e in wf.evidence}
        fix_ids = {r["chunk_id"] for r in out.result["results"]}
        wf.evidence = list(wf.evidence) + [{**r, "retrieval": "fix_guidance"} for r in out.result["results"] if r["chunk_id"] not in known]
        events.emit(db, wf, "evidence_retrieved", f"Targeted retrieval for '{rem['title']}': {len(fix_ids)} chunks",
                    {"backend": out.result["backend_label"], "results": [{k: r[k] for k in ("chunk_id", "title", "relevance", "trust", "above_threshold")}
                                                                       for r in out.result["results"]]})
    trusted = sorted([e for e in wf.evidence if e.get("trust") == "standard" and e.get("above_threshold")],
                     key=lambda e: (e.get("category") != topic, e["chunk_id"] not in fix_ids, -e["relevance"]))[:2]
    check = sandbox.REMEDIATIONS[dx.action]["verify_check"]
    base = len(steps)
    deps = [s.step_key for s in steps]
    new = [
        ("p1", "Propose grounded remediation", "propose_remediation",
         {"action": dx.action, "target_id": dx.target_id, "evidence_chunk_ids": [e["chunk_id"] for e in trusted],
          "diagnostic_summary": dx.finding[:600]}, deps, "Recommend a catalogued fix citing trusted evidence."),
        ("p2", sandbox.REMEDIATIONS[dx.action]["title"], "execute_sandbox_remediation",
         {"action": dx.action, "target_id": dx.target_id, "parameters": agent.REMEDIATION_PARAMS[dx.action]}, ["p1"],
         "Apply the fix in the sandbox; policy decides whether approval is needed."),
        ("p3", "Verify resolution", "verify_resolution", {"check": check, "target_id": dx.target_id}, ["p2"],
         "Re-run diagnostics; resolve only if verification passes."),
    ]
    for i, (key, title, tool, args, dep, why_) in enumerate(new):
        db.add(WorkflowStep(workflow_id=wf.id, step_key=key, position=base + i, title=title, tool=tool,
                            arguments=validate_args(tool, args), depends_on=dep, rationale=why_))
    set_state(wf, plan_revision=2)
    db.flush()
    events.emit(db, wf, "plan_revised", f"Plan revised from observations: {dx.action}",
                {"revision": 2, "steps": [{"key": k, "title": t, "tool": tl, "depends_on": d} for k, t, tl, _, d, _ in new]})
    return CONTINUE


def _after_success(db: Session, wf: WorkflowRun, step: WorkflowStep, result: dict[str, Any],
                   approval: ApprovalRequest | None = None) -> str:
    tool = step.tool
    if tool == "propose_remediation":
        if not result.get("grounded"):
            step.result_summary = result.get("reason")
            _skip_dependents(db, wf, step)
            return _request_review(db, wf, result.get("reason") or "Recommendation not grounded")
        step.result_summary = result["recommendation"]
        wf.risk = {"policy_id": result.get("policy_id"), "requires_approval": result.get("requires_approval")}
        events.emit(db, wf, "recommendation", result["recommendation"], {"citations": result.get("citations", []),
                                                                         "rejected_citations": result.get("rejected_citations", [])})
        note = " A support engineer must approve it before it runs." if result.get("requires_approval") else ""
        add_message(db, wf, "assistant", f"Recommended fix: {result['recommendation']}{note}", kind="recommendation",
                    meta={"citations": result.get("citations", []), "claims": result.get("claims", [])})
        return CONTINUE
    if tool == "execute_sandbox_remediation":
        step.result_summary = f"Applied {result.get('action')} in sandbox; changed {', '.join(result.get('changed_fields', [])) or 'nothing'}"
        events.emit(db, wf, "remediation_executed", step.result_summary,
                    {"approval_id": approval.id if approval else None, "result": result}, simulated=True)
        who = db.get(User, approval.decided_by) if approval and approval.decided_by else None
        add_message(db, wf, "assistant",
                    f"{'Approved by ' + who.name + '. ' if who else ''}Applied in the sandbox: {sandbox.REMEDIATIONS[result['action']]['title']}. Verifying now.",
                    kind="notice")
        return CONTINUE
    if tool == "verify_resolution":
        wf.verification = {**result, "verified_at": utcnow().isoformat()}
        step.result_summary = f"{'Verified' if result.get('verified') else 'Not verified'}: {result.get('observations')}"
        events.emit(db, wf, "verification", f"Verification {'passed' if result.get('verified') else 'failed'} ({result.get('check')})",
                    result, simulated=True)
        if result.get("verified") and result.get("requires_user_confirmation"):
            set_state(wf, pending_question={"kind": "confirmation", "question": "Diagnostics look healthy now. Is the laptop responsive again?"})
            add_message(db, wf, "assistant", "Diagnostics look healthy now. Is the laptop responsive again?", kind="confirmation")
            _sync_ticket(db, wf, "waiting_on_user")
            transition(db, wf, "awaiting_user_input", "Waiting for the requester to confirm the fix")
            events.notify(db, [wf.requester_id], "confirmation", "Did the fix work?", "Please confirm in the support workspace",
                          f"/support?wf={wf.id}")
            return STOP
        if result.get("verified"):
            return complete(db, wf, f"diagnostic check {result.get('check')}: {result.get('observations')}")
        return _request_review(db, wf, f"Verification failed after remediation ({result.get('check')}); not resolving the ticket",
                               severity="high")
    step.result_summary = _summarise(tool, result)
    return CONTINUE


def _summarise(tool: str, r: dict[str, Any]) -> str:
    if tool == "run_network_diagnostics":
        return "Failed checks: " + (", ".join(r.get("failed_checks", [])) or "none")
    if tool == "check_service_status":
        return f"{r.get('service')}: {r.get('status')}"
    if tool == "get_account_status":
        return f"locked={r.get('locked')}, failed_attempts={r.get('failed_attempts')}"
    if tool == "get_device_status" and r.get("kind") == "printer":
        return f"{r.get('name')}: {r.get('status')} {r.get('error_code') or ''}".strip()
    if tool == "get_device_status":
        return f"VPN {r.get('vpn', {}).get('session')}, Wi-Fi {r.get('wifi', {}).get('adapter')}, CPU {r.get('performance', {}).get('cpu_pct')}%"
    return "ok"


def complete(db: Session, wf: WorkflowRun, verification_text: str) -> str:
    diag = (wf.state or {}).get("diagnosis", {})
    action = diag.get("action")
    title = sandbox.REMEDIATIONS[action]["title"] if action in sandbox.REMEDIATIONS else "Resolved"
    _sync_ticket(db, wf, "resolved", resolution=f"{title}. Verified by {verification_text}"[:2000])
    transition(db, wf, "completed", "Resolved and verified", {"verification": wf.verification})
    add_message(db, wf, "assistant", f"Fixed and verified. {title}. Your ticket has been resolved.", kind="notice")
    events.notify(db, [wf.requester_id], "resolved", "Your issue is resolved", title, f"/support?wf={wf.id}")
    return STOP


HANDLERS = {
    "received": h_received,
    "classifying": h_classifying,
    "retrieving": h_retrieving,
    "planning": h_planning,
    "diagnosing": h_steps,
    "executing": h_steps,
    "verifying": h_steps,
}


# ================================================================== driver
def advance(workflow_id: str) -> None:
    for _ in range(80):
        outcome: str | _Retry = STOP
        with session_scope() as db:
            wf = db.get(WorkflowRun, workflow_id)
            if wf is None or wf.status in TERMINAL or wf.status in WAITING or wf.automation_paused:
                return
            if wf.cancel_requested:
                _do_cancel(db, wf, None, "Cancellation requested")
                return
            limits = runtime_settings.get_section(db, "execution")
            if wf.active_ms > float(limits["max_active_seconds"]) * 1000:
                _request_review(db, wf, f"Execution time budget exceeded ({limits['max_active_seconds']}s)")
                return
            handler = HANDLERS.get(wf.status)
            if handler is None:
                return
            t0 = time.perf_counter()
            try:
                outcome = handler(db, wf)
            except _Retry as r:
                outcome = r
            except llm.LLMError as exc:
                _account_llm(wf, getattr(exc, "calls", []))
                _fail(db, wf, f"llm_{exc.code}", f"Live LLM error: {exc.message}", retryable=False)
                set_state(wf, offer_demo_run=True)
                outcome = STOP
            except AppError:
                raise
            except Exception as exc:  # unexpected: fail visibly rather than loop
                db.rollback()
                wf = db.get(WorkflowRun, workflow_id)
                _fail(db, wf, "internal_error", f"{type(exc).__name__}: {str(exc)[:300]}")
                outcome = STOP
            wf.active_ms += int((time.perf_counter() - t0) * 1000)
            if isinstance(outcome, _Retry) and outcome.delay >= 0:
                enqueue(db, wf.id, delay=outcome.delay)
        if outcome != CONTINUE:
            return


def run_to_idle(workflow_id: str, honor_delays: bool = True, max_jobs: int = 50) -> None:
    """Drive one workflow until it waits or finishes (seed, evaluation, tests)."""
    advance(workflow_id)
    for _ in range(max_jobs):
        with session_scope() as db:
            job = db.scalar(select(Job).where(Job.workflow_id == workflow_id, Job.status == "queued").order_by(Job.run_after))
            if job is None:
                return
            wait = (job.run_after - utcnow()).total_seconds()
            job.status = "running"
            job_id = job.id
        if honor_delays and wait > 0:
            time.sleep(min(wait, 10))
        advance(workflow_id)
        with session_scope() as db:
            j = db.get(Job, job_id)
            if j:
                j.status = "done"


# ================================================================== API-facing operations
def submit_request(db: Session, user: User, text: str, mode: str, idempotency_key: str, options: dict[str, Any] | None = None,
                   origin: str = "live") -> tuple[WorkflowRun, bool]:
    existing = db.scalar(select(WorkflowRun).where(WorkflowRun.idempotency_key == f"{user.id}:{idempotency_key}"))
    if existing:
        return existing, False
    clean, found = redact_text(text.strip())
    demo = runtime_settings.get_section(db, "demo")
    opts = options or {}
    faults = {"ticketing": opts.get("ticketing_fault") or demo["ticketing_fault"],
              "verification": opts.get("verification_fault") or demo["verification_fault"]}
    wf = WorkflowRun(requester_id=user.id, idempotency_key=f"{user.id}:{idempotency_key}", original_request=clean, mode=mode,
                     origin=origin, status="received",
                     state={"faults": faults, "redactions": found, "clarifications": []},
                     model_config_snapshot=llm.models(db) if mode == "live" else {"planner": "deterministic demo planner"})
    db.add(wf)
    db.flush()
    conv = Conversation(user_id=user.id, workflow_id=wf.id)
    db.add(conv)
    db.flush()
    wf.conversation_id = conv.id
    db.add(Message(conversation_id=conv.id, author_role="user", author_id=user.id, content=clean,
                   meta={"redacted": found} if found else {}))
    events.emit(db, wf, "request_received", f"Request received ({mode} mode)",
                {"mode": mode, "faults": faults, "redactions": found}, simulated=mode == "demo")
    if found:
        add_message(db, wf, "system", "Sensitive values in your message were redacted before storage. Never share passwords with support.",
                    kind="notice")
    audit.record(db, action="request.submitted", resource_type="workflow", resource_id=wf.id, actor=user, workflow_id=wf.id,
                 details={"mode": mode, "faults": faults}, origin=origin)
    enqueue(db, wf.id)
    return wf, True


def reply(db: Session, user: User, wf: WorkflowRun, content: str) -> None:
    clean, _ = redact_text(content.strip())
    pq = (wf.state or {}).get("pending_question")
    is_requester = user.id == wf.requester_id
    role = "user" if is_requester else "engineer"
    add_message(db, wf, role, clean, author_id=user.id)
    if wf.status != "awaiting_user_input" or not pq or not is_requester:
        return
    kind = pq["kind"]
    clar = list(wf.state.get("clarifications", [])) + [{"text": clean, "at": utcnow().isoformat(), "for": kind}]
    set_state(wf, clarifications=clar, pending_question=None)
    if kind == "clarification":
        st = dict(wf.state)
        st.pop("classification", None)
        wf.state = {**st, "reclassified": True}
        transition(db, wf, "classifying", "Clarification received; re-classifying the same workflow")
        enqueue(db, wf.id)
    elif kind == "confirmation":
        confirm_fix(db, user, wf, _is_affirmative(clean))
    elif kind == "reviewer_info":
        apr = db.get(ApprovalRequest, pq["approval_id"])
        if apr and apr.status == "info_requested":
            apr.status = "pending"
        transition(db, wf, "awaiting_approval", "Requester answered the reviewer's question; approval pending again")
        events.notify(db, [pq.get("asked_by")] if pq.get("asked_by") else events.staff_ids(db), "approval_requested",
                      "Requester replied to your question", clean[:140], "/approvals")
    elif kind == "engineer_info":
        transition(db, wf, "awaiting_human_review", "Requester answered the engineer's question")
        if pq.get("asked_by"):
            events.notify(db, [pq["asked_by"]], "human_review", "Requester replied", clean[:140], f"/workflows/{wf.id}")


def _is_affirmative(text: str) -> bool:
    t = text.lower()
    return any(w in t for w in ("yes", "works", "working", "fixed", "resolved", "better", "fine now")) and not any(
        w in t for w in ("not ", "no ", "still", "doesn't", "isn't", "didn't"))


def confirm_fix(db: Session, user: User, wf: WorkflowRun, worked: bool) -> None:
    if user.id != wf.requester_id:
        raise forbidden("Only the requester can confirm whether the fix worked")
    if wf.status == "awaiting_user_input" and (wf.state or {}).get("pending_question", {}) not in (None, {}) and \
            wf.state["pending_question"].get("kind") != "confirmation":
        raise conflict("Workflow is waiting for a different answer")
    if wf.status == "awaiting_user_input":
        set_state(wf, pending_question=None)
        if worked and wf.verification.get("verified"):
            wf.verification = {**wf.verification, "user_confirmed": True, "confirmed_at": utcnow().isoformat()}
            complete(db, wf, f"diagnostic check {wf.verification.get('check')} and requester confirmation")
        else:
            _request_review(db, wf, "Requester reports the issue persists after remediation")
        audit.record(db, action="workflow.user_confirmation", resource_type="workflow", resource_id=wf.id, actor=user,
                     workflow_id=wf.id, ticket_id=wf.ticket_id, details={"worked": worked}, origin=wf.origin)
    elif wf.status == "completed" and not worked:
        wf.completed_at = None
        transition(db, wf, "awaiting_human_review", "Requester reports the issue is back; reopened for human review")
        _sync_ticket(db, wf, "in_progress", note="Reopened by requester")
        set_state(wf, review={"reason": "Reopened by requester", "group": "service_desk"})
        audit.record(db, action="workflow.reopened", resource_type="workflow", resource_id=wf.id, actor=user, workflow_id=wf.id,
                     ticket_id=wf.ticket_id, origin=wf.origin)
        events.notify(db, events.staff_ids(db), "human_review", "Ticket reopened by requester", wf.original_request[:100],
                      f"/workflows/{wf.id}")
    else:
        raise conflict("There is no fix awaiting confirmation")


def decide_approval(db: Session, user: User, apr: ApprovalRequest, decision: str, reason: str | None, params_hash: str) -> ApprovalRequest:
    if user.role not in apr.approver_roles:
        audit.record(db, action="approval.decision_denied", resource_type="approval", resource_id=apr.id, actor=user,
                     outcome="denied", workflow_id=apr.workflow_id, ticket_id=apr.ticket_id,
                     details={"decision": decision, "reason": "role not permitted"}, origin=apr.origin)
        db.commit()
        raise forbidden(f"Role '{user.role}' cannot decide {apr.policy_id} approvals")
    if user.id == apr.requester_id:
        raise forbidden("You cannot approve an action on your own request (separation of duties)")
    reason = (reason or "").strip() or None
    if decision == "reject" and not reason:
        raise bad_request("A reason is required to reject an action")
    if decision == "approve" and apr.reason_required and not reason:
        raise bad_request(f"{apr.policy_id} is a sensitive action; a reason is required to approve it")
    if decision == "request_info" and not reason:
        raise bad_request("Enter the question for the requester")
    if params_hash != apr.params_hash:
        raise conflict("These parameters are no longer current. Reload the approval and review the latest version.",
                       {"current_params_hash": apr.params_hash})
    new_status = {"approve": "approved", "reject": "rejected", "request_info": "info_requested"}[decision]
    allowed_from = ("pending",) if decision != "request_info" else ("pending",)
    rc = db.execute(update(ApprovalRequest).where(ApprovalRequest.id == apr.id, ApprovalRequest.status.in_(allowed_from),
                                                  ApprovalRequest.params_hash == params_hash)
                    .values(status=new_status, decided_by=user.id, decided_at=utcnow(), decision_reason=reason)).rowcount
    if rc != 1:
        db.rollback()
        current = db.get(ApprovalRequest, apr.id)
        raise conflict(f"Approval is already {current.status if current else 'gone'}; no action taken")
    db.refresh(apr)
    db.add(ApprovalDecision(approval_id=apr.id, reviewer_id=user.id, reviewer_role=user.role, decision=decision, reason=reason,
                            params_hash=params_hash))
    wf = db.get(WorkflowRun, apr.workflow_id)
    audit.record(db, action=f"approval.{new_status}", resource_type="approval", resource_id=apr.id, actor=user,
                 workflow_id=wf.id, ticket_id=wf.ticket_id,
                 details={"action": apr.action, "target": apr.target_resource, "params_hash": params_hash, "reason": reason,
                          "policy": apr.policy_id}, origin=wf.origin)
    events.emit(db, wf, "approval_decided", f"{user.name} ({user.role}) {new_status.replace('_', ' ')}: {apr.action_summary}",
                {"approval_id": apr.id, "decision": decision, "reviewer_id": user.id, "reason": reason})
    if decision == "request_info":
        set_state(wf, pending_question={"kind": "reviewer_info", "question": reason, "approval_id": apr.id, "asked_by": user.id})
        add_message(db, wf, "engineer", reason or "", kind="clarification", author_id=user.id)
        _sync_ticket(db, wf, "waiting_on_user")
        transition(db, wf, "awaiting_user_input", "Reviewer requested more information")
        events.notify(db, [wf.requester_id], "clarification", "A support engineer has a question", reason or "", f"/support?wf={wf.id}")
    else:
        enqueue(db, wf.id, dedupe_key=f"approval:{apr.id}:{decision}")
        if wf.status == "awaiting_approval":
            transition(db, wf, "executing" if decision == "approve" else "diagnosing",
                       "Approval granted; resuming from checkpoint" if decision == "approve" else "Approval rejected; choosing a safe next state")
    return apr


def edit_approval(db: Session, user: User, apr: ApprovalRequest, parameters: dict[str, Any], reason: str) -> ApprovalRequest:
    if user.role not in apr.approver_roles:
        raise forbidden()
    if apr.status not in ("pending", "info_requested"):
        raise conflict(f"Approval is {apr.status}; parameters can only be changed while pending")
    if not reason.strip():
        raise bad_request("A reason is required to change action parameters")
    step = db.get(WorkflowStep, apr.step_id)
    new_args = {**apr.parameters, "parameters": parameters}
    new_args = validate_args(apr.tool_name, new_args)
    if new_args["action"] != apr.parameters["action"] or new_args["target_id"] != apr.parameters["target_id"]:
        raise bad_request("Only remediation parameters can be edited; action and target are fixed")
    apr.status = "invalidated"
    step.arguments = new_args
    wf = db.get(WorkflowRun, apr.workflow_id)
    version = apr.action_version + 1
    new = ApprovalRequest(**{c: getattr(apr, c) for c in (
        "workflow_id", "step_id", "ticket_id", "requester_id", "tool_name", "action", "action_summary", "target_resource",
        "risk_level", "policy_id", "policy_text", "approver_roles", "reason_required", "evidence", "expected_effect", "origin")},
        parameters=new_args, action_version=version, params_hash=action_hash(wf.id, step.step_key, apr.tool_name, new_args, version))
    db.add(new)
    db.add(ApprovalDecision(approval_id=apr.id, reviewer_id=user.id, reviewer_role=user.role, decision="edit", reason=reason,
                            params_hash=apr.params_hash))
    db.flush()
    events.emit(db, wf, "approval_invalidated", f"{user.name} changed parameters; previous approval invalidated (v{apr.action_version} -> v{version})",
                {"old_approval_id": apr.id, "new_approval_id": new.id})
    audit.record(db, action="approval.parameters_changed", resource_type="approval", resource_id=new.id, actor=user,
                 workflow_id=wf.id, ticket_id=wf.ticket_id, details={"old": apr.parameters, "new": new_args, "reason": reason},
                 origin=wf.origin)
    return new


def _do_cancel(db: Session, wf: WorkflowRun, user: User | None, reason: str) -> None:
    for apr in db.scalars(select(ApprovalRequest).where(ApprovalRequest.workflow_id == wf.id,
                                                        ApprovalRequest.status.in_(["pending", "info_requested", "approved"]))):
        apr.status = "cancelled"
    _sync_ticket(db, wf, "cancelled", resolution=f"Cancelled: {reason}")
    transition(db, wf, "cancelled", f"Cancelled{' by ' + user.name if user else ''}: {reason}")
    audit.record(db, action="workflow.cancelled", resource_type="workflow", resource_id=wf.id, actor=user,
                 actor_role=None if user else "agent", workflow_id=wf.id, ticket_id=wf.ticket_id, details={"reason": reason},
                 origin=wf.origin)


def workflow_action(db: Session, user: User, wf: WorkflowRun, action: str, reason: str | None = None,
                    message: str | None = None, group: str | None = None, verification_note: str | None = None) -> None:
    staff = user.role in ("engineer", "admin")
    is_requester = user.id == wf.requester_id
    reason = (reason or "").strip() or None

    def need(cond: bool, msg: str) -> None:
        if not cond:
            raise conflict(msg)

    if action == "cancel":
        if not (staff or is_requester):
            raise forbidden()
        need(wf.status not in TERMINAL, f"Workflow is already {wf.status}")
        if wf.status in WAITING or wf.automation_paused:
            _do_cancel(db, wf, user, reason or "Cancelled by user")
        else:
            wf.cancel_requested = True
            events.emit(db, wf, "cancel_requested", f"Cancellation requested by {user.name}; stops before the next side effect")
        return
    if action == "confirm_fix":
        confirm_fix(db, user, wf, True)
        return
    if action == "reopen":
        confirm_fix(db, user, wf, False)
        return
    if not staff:
        raise forbidden("Only support engineers and administrators can perform this action")

    if action == "takeover":
        need(wf.status not in TERMINAL, f"Workflow is already {wf.status}")
        prev = wf.status
        wf.taken_over_by, wf.automation_paused = user.id, True
        if wf.ticket_id:
            t = db.get(Ticket, wf.ticket_id)
            if t:
                t.assignee_id = user.id
        if prev not in WAITING:
            set_state(wf, resume_status=prev)
            transition(db, wf, "awaiting_human_review", f"{user.name} took over; automation paused")
        else:
            events.emit(db, wf, "takeover", f"{user.name} took over; automation paused")
    elif action == "release":
        need(wf.automation_paused, "Automation is not paused")
        wf.automation_paused, wf.taken_over_by = False, None
        resume = (wf.state or {}).get("resume_status")
        if wf.status == "awaiting_human_review" and resume:
            set_state(wf, resume_status=None)
            transition(db, wf, resume, f"{user.name} handed the workflow back to automation")
            enqueue(db, wf.id)
        else:
            events.emit(db, wf, "released", f"{user.name} released the workflow")
    elif action in ("retry", "resume"):
        err = wf.error or {}
        need(wf.status == "failed" and err.get("retryable") and err.get("resume_status"),
             "Only failed workflows whose failed step is idempotent can be retried")
        retries = dict((wf.state or {}).get("retries", {}))
        retries.pop(err.get("retry_key"), None)
        set_state(wf, retries=retries)
        for s in _steps(db, wf):
            if s.status == "failed":
                s.status = "pending"
        wf.error, wf.completed_at = None, None
        transition(db, wf, err["resume_status"], f"Manual retry by {user.name}")
        enqueue(db, wf.id)
    elif action == "escalate":
        need(wf.status not in TERMINAL or wf.status == "failed", f"Workflow is already {wf.status}")
        need(bool(reason), "A reason is required to escalate")
        if wf.ticket_id:
            t = db.get(Ticket, wf.ticket_id)
            if t:
                t.status, t.assignee_id = "escalated", t.assignee_id or user.id
        set_state(wf, escalation={"group": group or "service_desk", "reason": reason, "by": user.id})
        transition(db, wf, "escalated", f"Escalated to {group or 'service_desk'} by {user.name}: {reason}")
        add_message(db, wf, "engineer", f"Your request has been escalated to {(group or 'service desk').replace('_', ' ')}: {reason}",
                    kind="notice", author_id=user.id)
        events.notify(db, [wf.requester_id], "escalated", "Your request was escalated", reason or "", f"/support?wf={wf.id}")
    elif action == "resolve":
        need(wf.status in WAITING or wf.status == "failed", "Only paused or waiting workflows can be resolved manually")
        need(bool(reason) and bool((verification_note or "").strip()),
             "Manual resolution requires a reason and verification evidence")
        wf.verification = {"verified": True, "method": "technician_attested", "note": verification_note, "by": user.id,
                           "verified_at": utcnow().isoformat()}
        if wf.ticket_id:
            t = db.get(Ticket, wf.ticket_id)
            if t:
                t.status, t.resolution, t.resolved_at = "resolved", f"{reason}. Verification: {verification_note}", utcnow()
                t.assignee_id = t.assignee_id or user.id
        for apr in db.scalars(select(ApprovalRequest).where(ApprovalRequest.workflow_id == wf.id, ApprovalRequest.status == "pending")):
            apr.status = "cancelled"
        wf.error = None
        transition(db, wf, "completed", f"Resolved by {user.name} with technician-attested verification")
        add_message(db, wf, "engineer", f"Resolved: {reason}. Verification: {verification_note}", kind="notice", author_id=user.id)
        events.notify(db, [wf.requester_id], "resolved", "Your issue is resolved", reason or "", f"/support?wf={wf.id}")
    elif action == "request_info":
        need(wf.status in ("awaiting_human_review", "failed"), "Request information while the workflow is in human review")
        need(bool((message or "").strip()), "Enter the question for the requester")
        set_state(wf, pending_question={"kind": "engineer_info", "question": message, "asked_by": user.id})
        add_message(db, wf, "engineer", message or "", kind="clarification", author_id=user.id)
        transition(db, wf, "awaiting_user_input", f"{user.name} requested more information")
        events.notify(db, [wf.requester_id], "clarification", "A support engineer has a question", (message or "")[:140],
                      f"/support?wf={wf.id}")
    else:
        raise bad_request(f"Unknown action '{action}'")
    audit.record(db, action=f"workflow.{action}", resource_type="workflow", resource_id=wf.id, actor=user, workflow_id=wf.id,
                 ticket_id=wf.ticket_id, details={"reason": reason, "group": group, "message": message,
                                                  "verification_note": verification_note}, origin=wf.origin)


def available_actions(user: User, wf: WorkflowRun) -> list[str]:
    staff = user.role in ("engineer", "admin")
    out: list[str] = []
    if wf.status not in TERMINAL and (staff or user.id == wf.requester_id):
        out.append("cancel")
    if user.id == wf.requester_id:
        pq = (wf.state or {}).get("pending_question") or {}
        if wf.status == "awaiting_user_input" and pq.get("kind") == "confirmation":
            out += ["confirm_fix", "reopen"]
        if wf.status == "completed":
            out.append("reopen")
    if staff:
        if wf.status not in TERMINAL and not wf.automation_paused:
            out.append("takeover")
        if wf.automation_paused:
            out.append("release")
        err = wf.error or {}
        if wf.status == "failed" and err.get("retryable") and err.get("resume_status"):
            out.append("retry")
        if wf.status in WAITING or wf.status == "failed":
            out += ["escalate", "resolve"]
        if wf.status in ("awaiting_human_review", "failed"):
            out.append("request_info")
    return out
