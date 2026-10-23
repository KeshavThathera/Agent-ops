"""Durable background worker. Jobs live in the database, so pending work survives restarts.

recover() runs at startup:
  - jobs left "running" by a crashed process are re-queued
  - workflows in an active state with no queued job get a new job
Approvals left in "executing" are reconciled by the engine via idempotency keys.
"""

from __future__ import annotations

import logging
import threading
import time

from sqlalchemy import select, update

from app import engine
from app.db import session_scope, utcnow
from app.models import Job, WorkflowRun

log = logging.getLogger("agentops.worker")
ACTIVE = set(engine.HANDLERS)


def recover() -> dict[str, int]:
    with session_scope() as db:
        requeued = db.execute(update(Job).where(Job.status == "running").values(status="queued", locked_at=None)).rowcount
        stranded = 0
        for wf in db.scalars(select(WorkflowRun).where(WorkflowRun.status.in_(ACTIVE), WorkflowRun.automation_paused.is_(False))):
            if not db.scalar(select(Job.id).where(Job.workflow_id == wf.id, Job.status == "queued")):
                db.add(Job(workflow_id=wf.id, kind="advance"))
                stranded += 1
    if requeued or stranded:
        log.info("recovery: requeued %s running jobs, enqueued %s stranded workflows", requeued, stranded)
    return {"requeued_jobs": requeued, "stranded_workflows": stranded}


def claim_next() -> Job | None:
    with session_scope() as db:
        job = db.scalar(select(Job).where(Job.status == "queued", Job.run_after <= utcnow()).order_by(Job.run_after, Job.created_at))
        if job is None:
            return None
        rc = db.execute(update(Job).where(Job.id == job.id, Job.status == "queued")
                        .values(status="running", locked_at=utcnow(), attempts=Job.attempts + 1)).rowcount
        if rc != 1:
            return None
        db.refresh(job)
        db.expunge(job)
        return job


def process(job: Job) -> None:
    try:
        if job.kind == "advance" and job.workflow_id:
            engine.advance(job.workflow_id)
        elif job.kind == "evaluation":
            from app import evaluation

            evaluation.execute_run(job.payload["run_id"])
        status, err = "done", None
    except Exception as exc:  # keep the worker alive; the job records the failure
        log.exception("job %s failed", job.id)
        status, err = "failed", f"{type(exc).__name__}: {exc}"[:1000]
    with session_scope() as db:
        j = db.get(Job, job.id)
        if j:
            j.status, j.last_error = status, err


def drain(max_jobs: int = 500, ignore_delay: bool = True) -> int:
    """Process jobs inline (tests and scripts). With ignore_delay, retry backoff is skipped."""
    n = 0
    for _ in range(max_jobs):
        if ignore_delay:
            with session_scope() as db:
                db.execute(update(Job).where(Job.status == "queued").values(run_after=utcnow()))
        job = claim_next()
        if job is None:
            break
        process(job)
        n += 1
    return n


class Worker(threading.Thread):
    def __init__(self, poll_seconds: float) -> None:
        super().__init__(name="agentops-worker", daemon=True)
        self.poll_seconds = poll_seconds
        self._halt = threading.Event()
        self.last_heartbeat: float = 0.0

    def run(self) -> None:
        recover()
        while not self._halt.is_set():
            self.last_heartbeat = time.time()
            try:
                job = claim_next()
            except Exception:
                log.exception("claim failed")
                job = None
            if job is None:
                self._halt.wait(self.poll_seconds)
                continue
            process(job)

    def stop(self) -> None:
        self._halt.set()


_worker: Worker | None = None


def start(poll_seconds: float) -> Worker:
    global _worker
    if _worker is None or not _worker.is_alive():
        _worker = Worker(poll_seconds)
        _worker.start()
    return _worker


def stop() -> None:
    if _worker is not None:
        _worker.stop()


def status() -> dict[str, object]:
    alive = bool(_worker and _worker.is_alive())
    return {"alive": alive, "last_heartbeat_age_s": round(time.time() - _worker.last_heartbeat, 1) if alive and _worker else None}
