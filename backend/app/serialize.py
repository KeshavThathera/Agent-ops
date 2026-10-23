"""Builds API payloads from ORM rows using the schemas in schemas.py."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import engine
from app.models import (
    ApprovalRequest, Message, Ticket, ToolCall, User, WorkflowEvent, WorkflowRun, WorkflowStep,
)
from app.schemas import (
    ApprovalOut, EventOut, MessageOut, StepOut, TicketOut, ToolCallOut, UserOut, WorkflowSummaryOut,
)

STATE_KEYS = ("classification", "pending_question", "diagnosis", "review", "sandbox", "faults", "escalation", "offer_demo_run",
              "plan_revision", "clarification_rounds", "redactions", "retries", "resume_status")


def user_out(u: User | None) -> dict[str, Any] | None:
    return UserOut.model_validate(u).model_dump(mode="json") if u else None


def ticket_out(db: Session, t: Ticket) -> dict[str, Any]:
    d = TicketOut.model_validate(t).model_dump(mode="json")
    d["requester"] = user_out(db.get(User, t.requester_id))
    d["assignee"] = user_out(db.get(User, t.assignee_id)) if t.assignee_id else None
    wf = db.get(WorkflowRun, t.workflow_id) if t.workflow_id else None
    d["workflow_status"] = wf.status if wf else None
    d["display_id"] = f"TKT-{t.number}"
    return d


def workflow_summary(db: Session, wf: WorkflowRun) -> dict[str, Any]:
    d = WorkflowSummaryOut.model_validate(wf).model_dump(mode="json")
    t = db.get(Ticket, wf.ticket_id) if wf.ticket_id else None
    d["ticket_number"] = t.number if t else None
    u = db.get(User, wf.requester_id)
    d["requester_name"] = u.name if u else None
    return d


def approval_out(db: Session, a: ApprovalRequest, viewer: User | None = None) -> dict[str, Any]:
    d = ApprovalOut.model_validate(a).model_dump(mode="json")
    req = db.get(User, a.requester_id)
    dec = db.get(User, a.decided_by) if a.decided_by else None
    t = db.get(Ticket, a.ticket_id) if a.ticket_id else None
    wf = db.get(WorkflowRun, a.workflow_id)
    d.update(requester_name=req.name if req else None, decided_by_name=dec.name if dec else None,
             ticket_number=t.number if t else None, request_text=wf.original_request if wf else None,
             can_decide=bool(viewer and viewer.role in a.approver_roles and viewer.id != a.requester_id and a.status == "pending"))
    return d


def workflow_detail(db: Session, wf: WorkflowRun, viewer: User) -> dict[str, Any]:
    steps = db.scalars(select(WorkflowStep).where(WorkflowStep.workflow_id == wf.id).order_by(WorkflowStep.position)).all()
    calls = db.scalars(select(ToolCall).where(ToolCall.workflow_id == wf.id).order_by(ToolCall.created_at)).all()
    approvals = db.scalars(select(ApprovalRequest).where(ApprovalRequest.workflow_id == wf.id)
                           .order_by(ApprovalRequest.created_at)).all()
    evs = db.scalars(select(WorkflowEvent).where(WorkflowEvent.workflow_id == wf.id).order_by(WorkflowEvent.id)).all()
    msgs = db.scalars(select(Message).where(Message.conversation_id == wf.conversation_id).order_by(Message.created_at)).all()
    t = db.get(Ticket, wf.ticket_id) if wf.ticket_id else None
    taker = db.get(User, wf.taken_over_by) if wf.taken_over_by else None
    authors = {m.author_id for m in msgs if m.author_id}
    names = {u.id: u.name for u in db.scalars(select(User).where(User.id.in_(authors)))} if authors else {}
    return {
        "workflow": workflow_summary(db, wf),
        "state": {k: (wf.state or {}).get(k) for k in STATE_KEYS},
        "plan_summary": wf.plan_summary,
        "evidence": wf.evidence or [],
        "risk": wf.risk or {},
        "verification": wf.verification or {},
        "error": wf.error,
        "model_config": wf.model_config_snapshot or {},
        "steps": [StepOut.model_validate(s).model_dump(mode="json") for s in steps],
        "tool_calls": [ToolCallOut.model_validate(c).model_dump(mode="json") for c in calls],
        "approvals": [approval_out(db, a, viewer) for a in approvals],
        "events": [EventOut.model_validate(e).model_dump(mode="json") for e in evs],
        "messages": [{**MessageOut.model_validate(m).model_dump(mode="json"), "author_name": names.get(m.author_id)} for m in msgs],
        "ticket": ticket_out(db, t) if t else None,
        "taken_over_by": user_out(taker),
        "available_actions": engine.available_actions(viewer, wf),
        "terminal": wf.status in engine.TERMINAL,
        "waiting": wf.status in engine.WAITING,
    }
