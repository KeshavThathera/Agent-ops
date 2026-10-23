"""Deterministic risk policy, enforced at execution time outside the LLM.

Every tool call is classified into an action class. The class maps to one of:
  automatic          - executes without human approval
  approval_required  - pauses the workflow until an authorised reviewer approves this exact action
  unavailable        - never executes in this prototype

Unknown tools and unclassified actions resolve to "unavailable" and are routed for review.
Text from retrieved documents or model output can never change these decisions.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from app import runtime_settings


@dataclass(frozen=True)
class Policy:
    id: str
    action_class: str
    description: str
    decision: str  # automatic | approval_required | unavailable
    risk_level: str  # low | medium | high | critical
    approver_roles: tuple[str, ...] = ()
    reason_required: bool = False
    editable: bool = False
    editable_values: tuple[str, ...] = ()


POLICIES: dict[str, Policy] = {
    p.action_class: p
    for p in [
        Policy("POL-KB-READ", "kb_read", "Read approved knowledge articles", "automatic", "low"),
        Policy("POL-DEVICE-READ", "device_read", "Read sandbox device and account status", "automatic", "low"),
        Policy("POL-DIAG", "diagnostic_readonly", "Run allowlisted read-only diagnostics", "automatic", "low"),
        Policy("POL-TICKET", "ticket_write", "Create or update a support ticket", "automatic", "low"),
        Policy("POL-RECOMMEND", "recommendation", "Suggest a fix grounded in evidence", "automatic", "low"),
        Policy(
            "POL-REVIEW",
            "human_review_request",
            "Pause and request human review (always allowed so the system can stop safely)",
            "automatic",
            "low",
        ),
        Policy(
            "POL-DEVICE-CHANGE",
            "device_config_change",
            "Change device or service configuration (sandbox)",
            "approval_required",
            "medium",
            approver_roles=("engineer", "admin"),
            editable=True,
            editable_values=("approval_required", "automatic"),
        ),
        Policy(
            "POL-ACCOUNT",
            "account_change",
            "Unlock or reset a user account (sandbox only in this prototype)",
            "approval_required",
            "high",
            approver_roles=("engineer", "admin"),
            reason_required=True,
        ),
        Policy(
            "POL-NOTIFY",
            "external_notification",
            "Send a notification to an external system (Slack, Teams, email)",
            "approval_required",
            "medium",
            approver_roles=("engineer", "admin"),
            editable=True,
            editable_values=("approval_required", "unavailable"),
        ),
        Policy("POL-DENY-DELETE", "record_delete", "Delete user accounts or records", "unavailable", "critical"),
        Policy("POL-DENY-SHELL", "arbitrary_command", "Execute arbitrary shell commands", "unavailable", "critical"),
        Policy("POL-DENY-BYPASS", "policy_bypass", "Bypass or disable approval policy", "unavailable", "critical"),
        Policy("POL-UNKNOWN", "unclassified", "Unknown tool or unclassified action", "unavailable", "high"),
    ]
}


@dataclass
class PolicyDecision:
    decision: str
    policy_id: str
    action_class: str
    description: str
    risk_level: str
    approver_roles: list[str] = field(default_factory=list)
    reason_required: bool = False

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def effective_policy(db: Session | None, action_class: str) -> Policy:
    base = POLICIES.get(action_class, POLICIES["unclassified"])
    if db is not None and base.editable:
        override = runtime_settings.get_section(db, "risk_policy").get(action_class)
        if override and override in base.editable_values and override != base.decision:
            return Policy(**{**asdict(base), "decision": override})
    return base


def decide(db: Session | None, action_class: str | None) -> PolicyDecision:
    p = effective_policy(db, action_class or "unclassified")
    return PolicyDecision(
        decision=p.decision,
        policy_id=p.id,
        action_class=p.action_class,
        description=p.description,
        risk_level=p.risk_level,
        approver_roles=list(p.approver_roles),
        reason_required=p.reason_required,
    )


def can_approve(role: str, decision_or_roles: PolicyDecision | list[str]) -> bool:
    roles = decision_or_roles.approver_roles if isinstance(decision_or_roles, PolicyDecision) else decision_or_roles
    return role in roles


def list_policies(db: Session) -> list[dict[str, Any]]:
    out = []
    for cls in POLICIES:
        p = effective_policy(db, cls)
        d = asdict(p)
        d["default_decision"] = POLICIES[cls].decision
        out.append(d)
    return out
