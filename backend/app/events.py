"""Workflow events (the observable execution trace) and user notifications."""

from __future__ import annotations

from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Notification, User, WorkflowEvent, WorkflowRun
from app.security import sanitize


def emit(
    db: Session,
    wf: WorkflowRun,
    type_: str,
    summary: str,
    data: dict[str, Any] | None = None,
    simulated: bool = False,
) -> WorkflowEvent:
    ev = WorkflowEvent(
        workflow_id=wf.id, type=type_, stage=wf.status, summary=summary, data=sanitize(data or {}), simulated=simulated
    )
    db.add(ev)
    db.flush()
    return ev


def notify(db: Session, user_ids: Iterable[str], type_: str, title: str, body: str = "", link: str | None = None) -> None:
    for uid in set(user_ids):
        user = db.get(User, uid)
        if user is None or user.is_system:
            continue
        prefs = (user.preferences or {}).get("notifications", {})
        if prefs.get(type_) is False:
            continue
        db.add(Notification(user_id=uid, type=type_, title=title, body=body, link=link))


def staff_ids(db: Session, roles: Iterable[str] = ("engineer", "admin")) -> list[str]:
    return list(db.scalars(select(User.id).where(User.role.in_(list(roles)), User.is_system.is_(False))).all())
