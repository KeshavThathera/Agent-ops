"""Core API: auth, support requests, workflows (+SSE), approvals, tickets, notifications, dashboard."""

from __future__ import annotations

import asyncio
import json
from collections import Counter
from datetime import timedelta

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app import audit, engine, serialize
from app.auth import STAFF, create_session, current_user, end_session, require_staff, visible_ticket, visible_workflow
from app.config import get_settings
from app.db import SessionLocal, get_db, utcnow
from app.errors import AppError, bad_request, conflict, forbidden, not_found
from app.models import (
    ApprovalRequest, Notification, Ticket, ToolCall, User, WorkflowEvent, WorkflowRun,
)
from app.schemas import (
    ApprovalDecisionIn, ApprovalEditIn, DemoLoginIn, EventOut, LoginIn, MarkReadIn, MessageIn, NotificationOut, SubmitRequestIn,
    TicketPatchIn, WorkflowActionIn,
)
from app.security import rate_limiter, verify_password

router = APIRouter(prefix="/api")


def client_ip(request: Request) -> str:
    """Real client address. Behind the Next.js proxy every request arrives from loopback, so the
    first X-Forwarded-For hop is used then (it is only trusted from loopback)."""
    host = request.client.host if request.client else "unknown"
    fwd = request.headers.get("x-forwarded-for")
    if host in ("127.0.0.1", "::1") and fwd:
        return fwd.split(",")[0].strip()
    return host


# ================================================================== auth
@router.get("/auth/config")
def auth_config(db: Session = Depends(get_db)):
    s = get_settings()
    demo_users = []
    if s.demo_accounts_enabled:
        demo_users = [serialize.user_out(u) for u in db.scalars(select(User).where(User.is_demo.is_(True)).order_by(User.role, User.name))]
    return {"demo_accounts_enabled": s.demo_accounts_enabled, "demo_users": demo_users,
            "demo_password_hint": s.demo_password if s.demo_accounts_enabled else None, "app_env": s.app_env}


@router.post("/auth/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    ip = client_ip(request)
    if not rate_limiter.allow(f"login:{ip}", 20, 60):
        raise AppError(429, "rate_limited", "Too many sign-in attempts; wait a minute")
    user = db.scalar(select(User).where(func.lower(User.email) == body.email.strip().lower()))
    if user is None or user.is_system or not verify_password(body.password, user.password_hash):
        audit.record(db, action="auth.login_failed", resource_type="user", outcome="denied", actor_role="system",
                     details={"email": body.email[:200]})
        db.commit()
        raise AppError(401, "invalid_credentials", "Email or password is incorrect")
    create_session(db, response, user)
    audit.record(db, action="auth.login", resource_type="user", resource_id=user.id, actor=user)
    db.commit()
    return serialize.user_out(user)


@router.post("/auth/demo-login")
def demo_login(body: DemoLoginIn, response: Response, db: Session = Depends(get_db)):
    """Convenience role switcher. Only exists when DEMO_ACCOUNTS_ENABLED=true, and only for seeded demo accounts."""
    if not get_settings().demo_accounts_enabled:
        raise not_found("Endpoint")
    user = db.scalar(select(User).where(User.email == body.email, User.is_demo.is_(True)))
    if user is None:
        raise AppError(401, "invalid_credentials", "Not a demo account")
    create_session(db, response, user)
    audit.record(db, action="auth.demo_login", resource_type="user", resource_id=user.id, actor=user)
    db.commit()
    return serialize.user_out(user)


@router.post("/auth/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    end_session(db, request, response)
    db.commit()
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(current_user)):
    return {**serialize.user_out(user), "preferences": user.preferences or {}}


@router.get("/users")
def list_users(role: str | None = None, db: Session = Depends(get_db), user: User = Depends(require_staff)):
    q = select(User).where(User.is_system.is_(False))
    if role:
        q = q.where(User.role == role)
    return [serialize.user_out(u) for u in db.scalars(q.order_by(User.name))]


# ================================================================== requests & workflows
@router.post("/requests", status_code=201)
def submit(body: SubmitRequestIn, response: Response, db: Session = Depends(get_db), user: User = Depends(current_user)):
    s = get_settings()
    if not rate_limiter.allow(f"submit:{user.id}", 12, 60):
        raise AppError(429, "rate_limited", "Too many requests; wait a minute")
    if body.mode == "live" and not s.llm_configured:
        raise AppError(400, "llm_not_configured",
                       "Live mode needs ANTHROPIC_API_KEY on the server. Start a demo run instead, or configure the provider.")
    if body.demo_options and s.app_env == "production":
        raise forbidden("Fault injection is only available outside production")
    for k, v in (body.demo_options or {}).items():
        allowed = {"ticketing_fault": {"none", "transient", "permanent"}, "verification_fault": {"none", "ineffective"}}[k]
        if v not in allowed:
            raise bad_request(f"Invalid value for {k}")
    wf, created = engine.submit_request(db, user, body.text, body.mode, body.idempotency_key, body.demo_options)
    db.commit()
    if not created:
        response.status_code = 200
    return {"workflow_id": wf.id, "created": created}


@router.get("/workflows")
def list_workflows(status: str | None = None, origin: str | None = None, mine: bool = False, page: int = Query(1, ge=1),
                   page_size: int = Query(20, ge=1, le=100), db: Session = Depends(get_db), user: User = Depends(current_user)):
    q = select(WorkflowRun)
    if user.role not in STAFF or mine:
        q = q.where(WorkflowRun.requester_id == user.id)
    if status:
        q = q.where(WorkflowRun.status.in_(status.split(",")))
    if origin:
        q = q.where(WorkflowRun.origin.in_(origin.split(",")))
    total = db.scalar(select(func.count()).select_from(q.subquery()))
    rows = db.scalars(q.order_by(WorkflowRun.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return {"items": [serialize.workflow_summary(db, w) for w in rows], "total": total, "page": page, "page_size": page_size}


@router.get("/workflows/{workflow_id}")
def get_workflow(workflow_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return serialize.workflow_detail(db, visible_workflow(db, user, workflow_id), user)


@router.get("/workflows/{workflow_id}/events")
async def stream_events(workflow_id: str, request: Request, after: int = 0, user: User = Depends(current_user)):
    """Server-Sent Events. Resumes after Last-Event-ID (or ?after=) so reconnects neither lose nor duplicate events."""

    def check() -> None:
        with SessionLocal() as db:
            visible_workflow(db, user, workflow_id)

    await run_in_threadpool(check)
    header = request.headers.get("last-event-id")
    last = int(header) if header and header.isdigit() else after

    def fetch(since: int):
        with SessionLocal() as db:
            rows = db.scalars(select(WorkflowEvent).where(WorkflowEvent.workflow_id == workflow_id, WorkflowEvent.id > since)
                              .order_by(WorkflowEvent.id).limit(200)).all()
            return [EventOut.model_validate(e).model_dump(mode="json") for e in rows]

    async def gen():
        nonlocal last
        yield "retry: 2000\n\n"
        ticks = 0
        while True:
            if await request.is_disconnected():
                break
            rows = await run_in_threadpool(fetch, last)
            for ev in rows:
                last = ev["id"]
                yield f"id: {ev['id']}\nevent: workflow\ndata: {json.dumps(ev)}\n\n"
            ticks += 1
            if not rows and ticks % 30 == 0:
                yield ": keepalive\n\n"
            await asyncio.sleep(0.4)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"})


@router.post("/workflows/{workflow_id}/messages")
def post_message(workflow_id: str, body: MessageIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    wf = visible_workflow(db, user, workflow_id)
    if user.id != wf.requester_id and user.role not in STAFF:
        raise forbidden()
    engine.reply(db, user, wf, body.content)
    db.commit()
    return serialize.workflow_detail(db, wf, user)


@router.post("/workflows/{workflow_id}/actions")
def workflow_action(workflow_id: str, body: WorkflowActionIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    wf = visible_workflow(db, user, workflow_id)
    try:
        engine.workflow_action(db, user, wf, body.action, body.reason, body.message, body.group, body.verification_note)
    except AppError as exc:
        if exc.status == 403:
            audit.record(db, action=f"workflow.{body.action}", resource_type="workflow", resource_id=wf.id, actor=user,
                         outcome="denied", workflow_id=wf.id, details={"reason": exc.message}, origin=wf.origin)
            db.commit()
        raise
    db.commit()
    return serialize.workflow_detail(db, wf, user)


@router.post("/workflows/{workflow_id}/demo-rerun", status_code=201)
def demo_rerun(workflow_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Explicit user choice to re-run a failed live request in demo mode. Never automatic."""
    wf = visible_workflow(db, user, workflow_id)
    if wf.requester_id != user.id:
        raise forbidden("Only the requester can start a demo run of their request")
    if wf.mode != "live" or wf.status != "failed":
        raise conflict("Only failed live runs can be re-run in demo mode")
    new, _ = engine.submit_request(db, user, wf.original_request, "demo", f"demo-rerun:{wf.id}")
    engine.events.emit(db, wf, "demo_rerun_started", f"User started a separate demo run: {new.id}", {"demo_workflow_id": new.id})
    db.commit()
    return {"workflow_id": new.id}


# ================================================================== approvals
@router.get("/approvals")
def list_approvals(status: str = "pending", origin: str | None = None, db: Session = Depends(get_db), user: User = Depends(require_staff)):
    q = select(ApprovalRequest)
    if status != "all":
        q = q.where(ApprovalRequest.status.in_(status.split(",")))
    if origin:
        q = q.where(ApprovalRequest.origin.in_(origin.split(",")))
    rows = db.scalars(q.order_by(ApprovalRequest.created_at.desc()).limit(200)).all()
    return [serialize.approval_out(db, a, user) for a in rows]


def _visible_approval(db: Session, user: User, approval_id: str) -> ApprovalRequest:
    a = db.get(ApprovalRequest, approval_id)
    if a is None:
        raise not_found("Approval")
    visible_workflow(db, user, a.workflow_id)
    return a


@router.get("/approvals/{approval_id}")
def get_approval(approval_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return serialize.approval_out(db, _visible_approval(db, user, approval_id), user)


@router.post("/approvals/{approval_id}/decision")
def decide(approval_id: str, body: ApprovalDecisionIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    a = _visible_approval(db, user, approval_id)
    a = engine.decide_approval(db, user, a, body.decision, body.reason, body.params_hash)
    db.commit()
    return serialize.approval_out(db, a, user)


@router.post("/approvals/{approval_id}/parameters")
def edit_parameters(approval_id: str, body: ApprovalEditIn, db: Session = Depends(get_db), user: User = Depends(require_staff)):
    a = _visible_approval(db, user, approval_id)
    try:
        new = engine.edit_approval(db, user, a, body.parameters, body.reason)
    except ValueError as exc:
        raise bad_request(f"Invalid parameters: {exc}") from exc
    db.commit()
    return serialize.approval_out(db, new, user)


# ================================================================== tickets
PRIORITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


@router.get("/tickets")
def list_tickets(q: str | None = None, status: str | None = None, category: str | None = None, priority: str | None = None,
                 assignee_id: str | None = None, origin: str | None = None,
                 sort: str = Query("created_at", pattern="^(created_at|updated_at|number|priority|status|title)$"),
                 order: str = Query("desc", pattern="^(asc|desc)$"), page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100),
                 db: Session = Depends(get_db), user: User = Depends(current_user)):
    stmt = select(Ticket)
    if user.role not in STAFF:
        stmt = stmt.where(Ticket.requester_id == user.id)
    if q:
        like = f"%{q.strip()}%"
        num = q.strip().upper().removeprefix("TKT-")
        conds = [Ticket.title.ilike(like), Ticket.description.ilike(like)]
        if num.isdigit():
            conds.append(Ticket.number == int(num))
        stmt = stmt.where(or_(*conds))
    for col, val in ((Ticket.status, status), (Ticket.category, category), (Ticket.priority, priority), (Ticket.origin, origin)):
        if val:
            stmt = stmt.where(col.in_(val.split(",")))
    if assignee_id == "unassigned":
        stmt = stmt.where(Ticket.assignee_id.is_(None))
    elif assignee_id:
        stmt = stmt.where(Ticket.assignee_id == assignee_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    if sort == "priority":
        from sqlalchemy import case

        key = case(PRIORITY_ORDER, value=Ticket.priority)
        stmt = stmt.order_by(key.desc() if order == "asc" else key.asc(), Ticket.created_at.desc())
    else:
        col = getattr(Ticket, sort)
        stmt = stmt.order_by(col.asc() if order == "asc" else col.desc())
    rows = db.scalars(stmt.offset((page - 1) * page_size).limit(page_size)).all()
    return {"items": [serialize.ticket_out(db, t) for t in rows], "total": total, "page": page, "page_size": page_size}


@router.get("/tickets/{ticket_id}")
def get_ticket(ticket_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    t = visible_ticket(db, user, ticket_id)
    wf = db.get(WorkflowRun, t.workflow_id) if t.workflow_id else None
    from app.models import AuditEvent

    history = []
    if user.role in STAFF:
        history = [{"id": a.id, "action": a.action, "actor_name": a.actor_name, "actor_role": a.actor_role, "outcome": a.outcome,
                    "details": a.details, "created_at": a.created_at.isoformat()}
                   for a in db.scalars(select(AuditEvent).where(AuditEvent.ticket_id == t.id).order_by(AuditEvent.id))]
    return {"ticket": serialize.ticket_out(db, t), "workflow": serialize.workflow_detail(db, wf, user) if wf else None,
            "history": history}


@router.patch("/tickets/{ticket_id}")
def patch_ticket(ticket_id: str, body: TicketPatchIn, db: Session = Depends(get_db), user: User = Depends(require_staff)):
    t = visible_ticket(db, user, ticket_id)
    changes = {}
    if body.priority and body.priority != t.priority:
        changes["priority"] = {"from": t.priority, "to": body.priority}
        t.priority = body.priority
    if body.unassign and t.assignee_id:
        changes["assignee_id"] = {"from": t.assignee_id, "to": None}
        t.assignee_id = None
    elif body.assignee_id and body.assignee_id != t.assignee_id:
        target = db.get(User, body.assignee_id)
        if target is None or target.role not in STAFF or target.is_system:
            raise bad_request("Tickets can only be assigned to support engineers or administrators")
        changes["assignee_id"] = {"from": t.assignee_id, "to": target.id, "to_name": target.name}
        t.assignee_id = target.id
    if not changes:
        raise bad_request("No changes")
    audit.record(db, action="ticket.updated", resource_type="ticket", resource_id=t.id, actor=user, ticket_id=t.id,
                 workflow_id=t.workflow_id, details={"changes": changes, "reason": body.reason}, origin=t.origin)
    if "assignee_id" in changes and t.assignee_id:
        engine.events.notify(db, [t.assignee_id], "assigned", f"TKT-{t.number} assigned to you", t.title, f"/tickets/{t.id}")
    db.commit()
    return serialize.ticket_out(db, t)


# ================================================================== notifications
@router.get("/notifications")
def notifications(db: Session = Depends(get_db), user: User = Depends(current_user)):
    rows = db.scalars(select(Notification).where(Notification.user_id == user.id).order_by(Notification.created_at.desc()).limit(30)).all()
    unread = db.scalar(select(func.count()).select_from(Notification).where(Notification.user_id == user.id, Notification.read.is_(False)))
    return {"items": [NotificationOut.model_validate(n).model_dump(mode="json") for n in rows], "unread": unread}


@router.post("/notifications/read")
def mark_read(body: MarkReadIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    q = select(Notification).where(Notification.user_id == user.id, Notification.read.is_(False))
    if body.ids:
        q = q.where(Notification.id.in_(body.ids))
    for n in db.scalars(q):
        n.read = True
    db.commit()
    return {"ok": True}


# ================================================================== dashboard
ACTIVE_STATES = set(engine.HANDLERS) | engine.WAITING


@router.get("/dashboard")
def dashboard(origin: str = Query("live", pattern="^(live|seed|eval|all)$"), db: Session = Depends(get_db),
              user: User = Depends(require_staff)):
    origins = ["live", "seed", "eval"] if origin == "all" else [origin]
    tickets = db.scalars(select(Ticket).where(Ticket.origin.in_(origins))).all()
    wfs = db.scalars(select(WorkflowRun).where(WorkflowRun.origin.in_(origins))).all()
    approvals_pending = db.scalar(select(func.count()).select_from(ApprovalRequest)
                                  .where(ApprovalRequest.origin.in_(origins), ApprovalRequest.status == "pending")) or 0
    finished = [w for w in wfs if w.status in engine.TERMINAL]
    verified = [w for w in wfs if w.status == "completed" and (w.verification or {}).get("verified")]
    escalated = [w for w in wfs if w.status in ("escalated", "awaiting_human_review")]
    since = utcnow() - timedelta(hours=24)
    wf_ids = [w.id for w in wfs]
    calls = db.scalars(select(ToolCall).where(ToolCall.created_at >= since, ToolCall.workflow_id.in_(wf_ids))).all() if wf_ids else []
    by_tool: dict[str, dict] = {}
    for c in calls:
        d = by_tool.setdefault(c.tool_name, {"tool": c.tool_name, "calls": 0, "errors": 0, "blocked": 0, "total_ms": 0, "last_error": None})
        d["calls"] += 1
        d["total_ms"] += c.duration_ms
        if c.status in ("error", "timeout"):
            d["errors"] += 1
            d["last_error"] = c.error
        if c.status == "blocked":
            d["blocked"] += 1
    tool_health = []
    for d in sorted(by_tool.values(), key=lambda x: x["tool"]):
        rate = d["errors"] / d["calls"] if d["calls"] else 0
        tool_health.append({**d, "avg_ms": round(d["total_ms"] / d["calls"], 1) if d["calls"] else 0,
                            "error_rate": round(rate, 3), "health": "healthy" if rate == 0 else ("degraded" if rate < 0.5 else "failing")})
    failures = sorted([c for c in calls if c.status in ("error", "timeout", "blocked")], key=lambda c: c.created_at, reverse=True)[:6]
    recent = db.scalars(select(WorkflowEvent).where(WorkflowEvent.workflow_id.in_(wf_ids)).order_by(WorkflowEvent.id.desc()).limit(12)).all() if wf_ids else []
    wf_map = {w.id: w for w in wfs}
    return {
        "origin": origin,
        "counts": {
            "total_tickets": len(tickets),
            "active_workflows": sum(w.status in ACTIVE_STATES for w in wfs),
            "pending_approvals": approvals_pending,
            "verified_resolutions": len(verified),
            "escalated_cases": len(escalated),
            "total_workflows": len(wfs),
            "avg_execution_ms": round(sum(w.active_ms for w in finished) / len(finished), 1) if finished else None,
            "finished_workflows": len(finished),
        },
        "ticket_status": [{"status": k, "count": v} for k, v in Counter(t.status for t in tickets).most_common()],
        "workflow_status": [{"status": k, "count": v} for k, v in Counter(w.status for w in wfs).most_common()],
        "category": [{"category": k, "count": v} for k, v in Counter(t.category for t in tickets).most_common()],
        "tool_health": tool_health,
        "recent_failures": [{"id": c.id, "tool": c.tool_name, "status": c.status, "error": c.error, "workflow_id": c.workflow_id,
                             "created_at": c.created_at.isoformat()} for c in failures],
        "recent_activity": [{"id": e.id, "workflow_id": e.workflow_id, "type": e.type, "summary": e.summary, "simulated": e.simulated,
                             "created_at": e.created_at.isoformat(),
                             "request": wf_map[e.workflow_id].original_request[:80] if e.workflow_id in wf_map else None}
                            for e in recent],
        "definitions": {
            "active_workflows": "Workflows not in a terminal state (includes waiting for approval, user input or human review).",
            "verified_resolutions": "Completed workflows whose verification record is verified=true.",
            "escalated_cases": "Workflows escalated or currently awaiting human review.",
            "avg_execution_ms": "Mean automated processing time of finished workflows; excludes time waiting for people.",
        },
    }
