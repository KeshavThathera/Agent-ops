"""Server-side sessions (httpOnly cookie, hashed token at rest), RBAC dependencies and CSRF guard."""

from __future__ import annotations

from datetime import timedelta

from fastapi import Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db, utcnow
from app.errors import AppError, forbidden, not_found
from app.models import AuthSession, Ticket, User, WorkflowRun
from app.security import new_session_token, token_digest

COOKIE = "agentops_session"
CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "agentops-desk"
STAFF = ("engineer", "admin")


def create_session(db: Session, response: Response, user: User) -> None:
    token = new_session_token()
    s = get_settings()
    db.add(AuthSession(token_hash=token_digest(token), user_id=user.id, expires_at=utcnow() + timedelta(hours=s.session_ttl_hours)))
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax", secure=s.cookie_secure, max_age=s.session_ttl_hours * 3600,
                        path="/")


def end_session(db: Session, request: Request, response: Response) -> None:
    token = request.cookies.get(COOKIE)
    if token:
        sess = db.scalar(select(AuthSession).where(AuthSession.token_hash == token_digest(token)))
        if sess:
            sess.revoked = True
    response.delete_cookie(COOKIE, path="/")


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(COOKIE)
    if not token:
        raise AppError(401, "unauthenticated", "Sign in required")
    sess = db.scalar(select(AuthSession).where(AuthSession.token_hash == token_digest(token)))
    if sess is None or sess.revoked or sess.expires_at < utcnow():
        raise AppError(401, "unauthenticated", "Session expired; sign in again")
    user = db.get(User, sess.user_id)
    if user is None or user.is_system:
        raise AppError(401, "unauthenticated", "Account unavailable")
    return user


def require_roles(*roles: str):
    def dep(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise forbidden(f"This action requires one of the roles: {', '.join(roles)}")
        return user

    return dep


def require_staff(user: User = Depends(current_user)) -> User:
    if user.role not in STAFF:
        raise forbidden("Support engineer or administrator role required")
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise forbidden("Administrator role required")
    return user


def visible_workflow(db: Session, user: User, workflow_id: str) -> WorkflowRun:
    """Ownership check. Unrelated users get 404 so record existence is not disclosed."""
    wf = db.get(WorkflowRun, workflow_id)
    if wf is None or (user.role not in STAFF and wf.requester_id != user.id):
        raise not_found("Workflow")
    return wf


def visible_ticket(db: Session, user: User, ticket_id: str) -> Ticket:
    t = db.get(Ticket, ticket_id)
    if t is None or (user.role not in STAFF and t.requester_id != user.id):
        raise not_found("Ticket")
    return t


async def csrf_guard(request: Request, call_next):
    """State-changing API calls must carry a custom header. Browsers cannot send it cross-site without a CORS
    preflight, which this API does not grant to other origins. Combined with SameSite=Lax cookies."""
    if request.url.path.startswith("/api/") and request.method in ("POST", "PUT", "PATCH", "DELETE"):
        if request.headers.get(CSRF_HEADER) != CSRF_VALUE:
            from fastapi.responses import JSONResponse

            return JSONResponse(status_code=403, content={"error": {"code": "csrf_failed",
                                                                    "message": "Missing X-Requested-With header", "details": None}})
    return await call_next(request)
