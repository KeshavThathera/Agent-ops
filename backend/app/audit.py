"""Append-only application audit trail.

Rows are never updated or deleted by the application (enforced by ORM listeners in
models.py and by the absence of any update/delete API). This is not cryptographic
tamper-proofing: anyone with direct database access can still modify rows.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.models import AuditEvent, User
from app.security import sanitize


def record(
    db: Session,
    *,
    action: str,
    resource_type: str,
    outcome: str = "success",
    actor: User | None = None,
    actor_role: str | None = None,
    resource_id: str | None = None,
    workflow_id: str | None = None,
    ticket_id: str | None = None,
    details: dict[str, Any] | None = None,
    origin: str = "live",
) -> AuditEvent:
    ev = AuditEvent(
        actor_id=actor.id if actor else None,
        actor_name=actor.name if actor else ("AgentOps workflow engine" if actor_role == "agent" else "System"),
        actor_role=actor_role or (actor.role if actor else "system"),
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        workflow_id=workflow_id,
        ticket_id=ticket_id,
        outcome=outcome,
        details=sanitize(details or {}),
        origin=origin,
    )
    db.add(ev)
    return ev
