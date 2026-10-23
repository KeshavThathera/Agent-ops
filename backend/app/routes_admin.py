"""Knowledge base, tools/integrations, evaluation, audit, settings and system endpoints."""

from __future__ import annotations

import asyncio
import re
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app import audit, evaluation, llm, policy, rag, runtime_settings, worker
from app.auth import STAFF, current_user, require_admin, require_staff
from app.config import get_settings
from app.db import get_db, utcnow
from app.errors import AppError, bad_request, not_found
from app.models import (
    AppSetting, AuditEvent, EvaluationCase, EvaluationResult, EvaluationRun, IntegrationConfig, Job, KnowledgeChunk,
    KnowledgeDocument, ToolCall, User,
)
from app.schemas import AuditOut, ChunkOut, DocumentOut, EvaluationRunIn, KnowledgeSearchIn, ResetIn, ToolCallOut
from app.tools import REGISTRY, describe_registry

router = APIRouter(prefix="/api")


# ================================================================== knowledge
def _doc(d: KnowledgeDocument) -> dict:
    return DocumentOut.model_validate(d).model_dump(mode="json")


@router.get("/knowledge")
def list_docs(q: str | None = None, status: str | None = None, db: Session = Depends(get_db), user: User = Depends(current_user)):
    stmt = select(KnowledgeDocument)
    if user.role not in STAFF:
        stmt = stmt.where(KnowledgeDocument.status == "indexed")
    if status:
        stmt = stmt.where(KnowledgeDocument.status.in_(status.split(",")))
    if q:
        stmt = stmt.where(or_(KnowledgeDocument.title.ilike(f"%{q}%"), KnowledgeDocument.slug.ilike(f"%{q}%")))
    return [_doc(d) for d in db.scalars(stmt.order_by(KnowledgeDocument.title))]


@router.get("/knowledge/{doc_id}")
def get_doc(doc_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    d = db.get(KnowledgeDocument, doc_id) or db.scalar(select(KnowledgeDocument).where(KnowledgeDocument.slug == doc_id))
    if d is None or (user.role not in STAFF and d.status != "indexed"):
        raise not_found("Document")
    chunks = db.scalars(select(KnowledgeChunk).where(KnowledgeChunk.document_id == d.id).order_by(KnowledgeChunk.chunk_index)).all()
    return {"document": _doc(d), "content": d.content_text, "chunks": [ChunkOut.model_validate(c).model_dump(mode="json") for c in chunks]}


@router.get("/knowledge/{doc_id}/file")
def download_original(doc_id: str, db: Session = Depends(get_db), user: User = Depends(require_staff)):
    d = db.get(KnowledgeDocument, doc_id)
    if d is None or not d.storage_path or not Path(d.storage_path).exists():
        raise not_found("Original file")
    return FileResponse(d.storage_path, filename=d.filename or Path(d.storage_path).name,
                        headers={"X-Content-Type-Options": "nosniff", "Content-Disposition": f'attachment; filename="{d.filename}"'})


@router.post("/knowledge/search")
def search(body: KnowledgeSearchIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    cfg = runtime_settings.get_section(db, "retrieval")
    backend = body.backend or get_settings().retrieval_backend
    if backend == "chroma" and get_settings().retrieval_backend != "chroma":
        raise bad_request("Vector backend is not enabled on this server (RETRIEVAL_BACKEND=chroma)")
    return rag.search(db, body.query, body.top_k or int(cfg["top_k"]), float(cfg["min_relevance"]), backend)


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "document"


async def _read_limited(file: UploadFile) -> bytes:
    limit = get_settings().max_upload_bytes
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise AppError(413, "file_too_large", f"File exceeds the {limit // (1024 * 1024)} MB limit")
    if not data:
        raise bad_request("File is empty")
    return data


def _store_and_index(db: Session, doc: KnowledgeDocument, filename: str, data: bytes) -> None:
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    folder = get_settings().data_dir / "uploads" / doc.id
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"v{doc.version}{ext}"
    path.write_bytes(data)
    doc.storage_path, doc.filename = str(path), filename[:200]
    try:
        ctype = rag.detect_content_type(filename, data)
        doc.content_type = ctype
        text = rag.extract_text(ctype, data)
        if len(text.strip()) < 20:
            raise rag.ExtractionError("failed", "No readable text found in the file")
        rag.index_document(db, doc, text)
    except rag.ExtractionError as exc:
        rag.remove_from_index(db, doc)
        doc.status, doc.status_detail, doc.content_text = exc.status, exc.message, ""


@router.post("/knowledge/upload", status_code=201)
async def upload(file: UploadFile = File(...), title: str = Form(..., min_length=3, max_length=200), tags: str = Form(""),
                 category: str | None = Form(None), db: Session = Depends(get_db), user: User = Depends(require_admin)):
    data = await _read_limited(file)
    name = Path(file.filename or "upload").name
    slug = _slugify(title)
    if db.scalar(select(KnowledgeDocument.id).where(KnowledgeDocument.slug == slug)):
        slug = f"{slug}-{utcnow().strftime('%H%M%S')}"
    doc = KnowledgeDocument(slug=slug, title=title.strip(), source="upload", content_type="text", version=1,
                            tags=[t.strip() for t in tags.split(",") if t.strip()][:8], category=category or None,
                            status="failed", uploaded_by=user.id)
    db.add(doc)
    db.flush()
    await run_in_threadpool(_store_and_index, db, doc, name, data)
    audit.record(db, action="knowledge.uploaded", resource_type="knowledge_document", resource_id=doc.id, actor=user,
                 outcome="success" if doc.status == "indexed" else "failure",
                 details={"title": doc.title, "filename": name, "status": doc.status, "detail": doc.status_detail,
                          "chunks": doc.chunk_count, "trust_flags": doc.trust_flags})
    db.commit()
    return _doc(doc)


@router.post("/knowledge/{doc_id}/replace")
async def replace(doc_id: str, file: UploadFile = File(...), db: Session = Depends(get_db), user: User = Depends(require_admin)):
    doc = db.get(KnowledgeDocument, doc_id)
    if doc is None:
        raise not_found("Document")
    data = await _read_limited(file)
    doc.version += 1
    doc.source = "upload" if doc.source != "seed" else "seed"
    await run_in_threadpool(_store_and_index, db, doc, Path(file.filename or "upload").name, data)
    audit.record(db, action="knowledge.replaced", resource_type="knowledge_document", resource_id=doc.id, actor=user,
                 outcome="success" if doc.status == "indexed" else "failure",
                 details={"version": doc.version, "status": doc.status, "chunks": doc.chunk_count})
    db.commit()
    return _doc(doc)


@router.post("/knowledge/{doc_id}/reindex")
def reindex(doc_id: str, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    doc = db.get(KnowledgeDocument, doc_id)
    if doc is None:
        raise not_found("Document")
    if doc.status not in ("indexed", "failed") or not doc.content_text:
        raise bad_request(f"Cannot reindex a document with status '{doc.status}' and no extracted text")
    rag.index_document(db, doc, doc.content_text)
    audit.record(db, action="knowledge.reindexed", resource_type="knowledge_document", resource_id=doc.id, actor=user,
                 details={"version": doc.version, "chunks": doc.chunk_count, "backend": doc.indexed_backend})
    db.commit()
    return _doc(doc)


@router.post("/knowledge/{doc_id}/archive")
def archive(doc_id: str, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    doc = db.get(KnowledgeDocument, doc_id)
    if doc is None:
        raise not_found("Document")
    rag.remove_from_index(db, doc)
    doc.status, doc.status_detail = "archived", f"Archived by {user.name}"
    audit.record(db, action="knowledge.archived", resource_type="knowledge_document", resource_id=doc.id, actor=user,
                 details={"title": doc.title})
    db.commit()
    return _doc(doc)


# ================================================================== tools & integrations
@router.get("/tools")
def tools(db: Session = Depends(get_db), user: User = Depends(require_staff)):
    out = []
    for t in describe_registry(db):
        calls = db.scalars(select(ToolCall).where(ToolCall.tool_name == t["name"]).order_by(ToolCall.created_at.desc()).limit(50)).all()
        n = len(calls)
        errors = sum(c.status in ("error", "timeout") for c in calls)
        health = "no_recent_calls" if n == 0 else ("healthy" if errors == 0 else ("degraded" if errors / n < 0.5 else "failing"))
        if t["integration"]:
            health = "not_configured"
        out.append({**t, "health": health, "recent_call_count": n, "recent_error_count": errors,
                    "avg_ms": round(sum(c.duration_ms for c in calls) / n, 1) if n else None,
                    "recent_calls": [ToolCallOut.model_validate(c).model_dump(mode="json") for c in calls[:5]]})
    probe = db.get(AppSetting, "mcp_probe")
    return {"tools": out, "policies": policy.list_policies(db), "mcp": probe.value if probe else None,
            "transport": runtime_settings.get_section(db, "demo")["tool_transport"]}


@router.get("/tools/{name}/calls")
def tool_calls(name: str, limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db), user: User = Depends(require_staff)):
    if name not in REGISTRY:
        raise not_found("Tool")
    rows = db.scalars(select(ToolCall).where(ToolCall.tool_name == name).order_by(ToolCall.created_at.desc()).limit(limit)).all()
    return [ToolCallOut.model_validate(c).model_dump(mode="json") for c in rows]


@router.post("/tools/mcp/probe")
async def mcp_probe(db: Session = Depends(get_db), user: User = Depends(require_admin)):
    from app import mcp_client

    started = utcnow()
    try:
        result = await asyncio.wait_for(mcp_client.probe(), timeout=45)
        result["ok"] = True
    except Exception as exc:
        result = {"ok": False, "connected": False, "error": f"{type(exc).__name__}: {str(exc)[:300]}"}
    result["checked_at"] = started.isoformat()
    row = db.get(AppSetting, "mcp_probe") or AppSetting(key="mcp_probe", value={})
    row.value = result
    db.merge(row)
    audit.record(db, action="integration.mcp_probe", resource_type="integration", resource_id="mcp", actor=user,
                 outcome="success" if result.get("ok") else "failure", details={"protocol": result.get("protocol_version")})
    db.commit()
    return result


@router.get("/integrations")
def integrations(db: Session = Depends(get_db), user: User = Depends(require_admin)):
    s = get_settings()
    rows = db.scalars(select(IntegrationConfig).order_by(IntegrationConfig.name)).all()
    probe = db.get(AppSetting, "mcp_probe")
    chroma_ok = None
    if s.retrieval_backend == "chroma":
        try:
            chroma_ok = rag.vector_store().count()
        except Exception as exc:  # report, don't hide
            chroma_ok = f"error: {type(exc).__name__}"
    return {
        "connectors": [{"id": r.id, "name": r.name, "kind": r.kind, "status": r.status, "implemented": r.implemented,
                        "config": r.config} for r in rows],
        "llm": {"provider": s.llm_provider, "configured": s.llm_configured, "models": llm.models(db),
                "refusal_fallback": s.llm_refusal_fallback,
                "note": "API key is read from the server environment only and never sent to the browser."},
        "retrieval": {"backend": s.retrieval_backend, "label": rag.backend_label(s.retrieval_backend), "vector_chunks": chroma_ok},
        "mcp": probe.value if probe else {"connected": None, "note": "Not probed yet"},
    }


# ================================================================== evaluation
@router.get("/evaluations")
def eval_runs(db: Session = Depends(get_db), user: User = Depends(require_admin)):
    runs = db.scalars(select(EvaluationRun).order_by(EvaluationRun.created_at.desc()).limit(20)).all()
    return {"runs": [{"id": r.id, "mode": r.mode, "systems": r.systems, "status": r.status, "dataset_version": r.dataset_version,
                      "summary": r.summary, "error": r.error, "created_at": r.created_at.isoformat(),
                      "started_at": r.started_at.isoformat() if r.started_at else None,
                      "finished_at": r.finished_at.isoformat() if r.finished_at else None} for r in runs],
            "definitions": evaluation.METRIC_DEFINITIONS, "dataset_version": evaluation.DATASET_VERSION,
            "cases": [{"key": c["key"], "title": c["title"], "input": c["input"], "expected": c["expected"], "harness": c["harness"]}
                      for c in evaluation.CASES]}


@router.post("/evaluations/runs", status_code=201)
def start_eval(body: EvaluationRunIn, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    if body.mode == "live" and not get_settings().llm_configured:
        raise AppError(400, "llm_not_configured", "Live evaluation needs ANTHROPIC_API_KEY on the server")
    if db.scalar(select(EvaluationRun.id).where(EvaluationRun.status.in_(["queued", "running"]))):
        raise AppError(409, "conflict", "An evaluation is already running")
    run = EvaluationRun(dataset_version=evaluation.DATASET_VERSION, mode=body.mode, systems=list(dict.fromkeys(body.systems)),
                        model_config_snapshot=evaluation.model_snapshot(db, body.mode), created_by=user.id)
    db.add(run)
    db.flush()
    db.add(Job(kind="evaluation", payload={"run_id": run.id}))
    audit.record(db, action="evaluation.started", resource_type="evaluation", resource_id=run.id, actor=user,
                 details={"mode": body.mode, "systems": run.systems})
    db.commit()
    return {"id": run.id}


@router.get("/evaluations/runs/{run_id}")
def eval_run(run_id: str, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    run = db.get(EvaluationRun, run_id)
    if run is None:
        raise not_found("Evaluation run")
    results = db.scalars(select(EvaluationResult).where(EvaluationResult.run_id == run_id)
                         .order_by(EvaluationResult.case_key, EvaluationResult.system)).all()
    cases = {c.key: c for c in db.scalars(select(EvaluationCase).where(EvaluationCase.dataset_version == run.dataset_version))}
    return {"run": {"id": run.id, "mode": run.mode, "systems": run.systems, "status": run.status, "dataset_version": run.dataset_version,
                    "summary": run.summary, "error": run.error, "model_config": run.model_config_snapshot,
                    "created_at": run.created_at.isoformat(), "started_at": run.started_at.isoformat() if run.started_at else None,
                    "finished_at": run.finished_at.isoformat() if run.finished_at else None},
            "results": [{"case_key": r.case_key, "case_title": cases[r.case_key].title if r.case_key in cases else r.case_key,
                         "input": cases[r.case_key].input_text if r.case_key in cases else None,
                         "expected": cases[r.case_key].expected if r.case_key in cases else {},
                         "system": r.system, "outcome": r.outcome, "passed": r.passed, "checks": r.checks, "claims": r.claims,
                         "tools_called": r.tools_called, "workflow_id": r.workflow_id, "duration_ms": r.duration_ms,
                         "input_tokens": r.input_tokens, "output_tokens": r.output_tokens, "cost_usd": r.cost_usd}
                        for r in results],
            "definitions": evaluation.METRIC_DEFINITIONS}


@router.get("/evaluations/runs/{run_id}/export")
def eval_export(run_id: str, format: str = Query("csv", pattern="^(csv|json)$"), db: Session = Depends(get_db),
                user: User = Depends(require_admin)):
    run = db.get(EvaluationRun, run_id)
    if run is None:
        raise not_found("Evaluation run")
    body, media = evaluation.export(db, run, format)
    return Response(body, media_type=media, headers={"Content-Disposition": f'attachment; filename="evaluation-{run.id}.{format}"'})


# ================================================================== audit
@router.get("/audit")
def audit_log(action: str | None = None, actor_id: str | None = None, outcome: str | None = None, resource_type: str | None = None,
              workflow_id: str | None = None, origin: str | None = None, q: str | None = None, since: datetime | None = None,
              page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200), db: Session = Depends(get_db),
              user: User = Depends(require_admin)):
    stmt = select(AuditEvent)
    if action:
        stmt = stmt.where(AuditEvent.action.startswith(action))
    for col, val in ((AuditEvent.actor_id, actor_id), (AuditEvent.resource_type, resource_type), (AuditEvent.workflow_id, workflow_id)):
        if val:
            stmt = stmt.where(col == val)
    if outcome:
        stmt = stmt.where(AuditEvent.outcome.in_(outcome.split(",")))
    if origin:
        stmt = stmt.where(AuditEvent.origin.in_(origin.split(",")))
    if since:
        stmt = stmt.where(AuditEvent.created_at >= since)
    if q:
        stmt = stmt.where(or_(AuditEvent.action.ilike(f"%{q}%"), AuditEvent.actor_name.ilike(f"%{q}%"), AuditEvent.resource_id.ilike(f"%{q}%")))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(AuditEvent.id.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return {"items": [AuditOut.model_validate(r).model_dump(mode="json") for r in rows], "total": total, "page": page,
            "page_size": page_size}


# ================================================================== settings
@router.get("/settings")
def get_settings_all(db: Session = Depends(get_db), user: User = Depends(current_user)):
    s = get_settings()
    out = {"profile": {**{k: getattr(user, k) for k in ("id", "name", "email", "role", "department")}, "preferences": user.preferences or {}},
           "server": {"app_env": s.app_env, "llm_configured": s.llm_configured, "llm_provider": s.llm_provider,
                      "retrieval_backend": s.retrieval_backend, "demo_accounts_enabled": s.demo_accounts_enabled,
                      "database": "sqlite" if s.database_url.startswith("sqlite") else s.database_url.split(":", 1)[0]}}
    if user.role == "admin":
        out["runtime"] = runtime_settings.get_all(db)
        out["policies"] = policy.list_policies(db)
        out["models"] = llm.models(db)
    return out


@router.put("/settings/{section}")
def put_settings(section: str, body: dict, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    before = runtime_settings.get_section(db, section) if section in runtime_settings.DEFAULTS else {}
    try:
        after = runtime_settings.put_section(db, section, body, user.id)
    except ValueError as exc:
        raise bad_request(str(exc)) from exc
    action = "policy.changed" if section == "risk_policy" else "settings.changed"
    audit.record(db, action=action, resource_type="settings", resource_id=section, actor=user,
                 details={"before": {k: before.get(k) for k in body}, "after": {k: after.get(k) for k in body}})
    db.commit()
    return runtime_settings.get_section(db, section)


@router.put("/me/preferences")
def put_prefs(body: dict, db: Session = Depends(get_db), user: User = Depends(current_user)):
    allowed = {"approval_requested", "clarification", "resolved", "human_review", "workflow_failed", "escalated", "assigned",
               "confirmation", "policy_denied"}
    notif = body.get("notifications", {})
    if not isinstance(notif, dict) or not set(notif) <= allowed or not all(isinstance(v, bool) for v in notif.values()):
        raise bad_request("Invalid notification preferences")
    user.preferences = {**(user.preferences or {}), "notifications": {**(user.preferences or {}).get("notifications", {}), **notif}}
    db.commit()
    return user.preferences


@router.post("/admin/reset-demo")
def reset_demo(body: ResetIn, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    s = get_settings()
    if s.app_env == "production" or not s.demo_accounts_enabled:
        raise AppError(403, "forbidden", "Demo reset is only available in a demo environment")
    if body.confirm != "RESET DEMO DATA":
        raise bad_request("Type RESET DEMO DATA to confirm")
    from app import seed

    summary = seed.reset_demo_data(db, user)
    db.commit()
    return summary


# ================================================================== system
@router.get("/system/status")
def system_status(db: Session = Depends(get_db), user: User = Depends(current_user)):
    s = get_settings()
    return {"app_env": s.app_env, "llm_configured": s.llm_configured, "retrieval_backend": s.retrieval_backend,
            "retrieval_label": rag.backend_label(s.retrieval_backend), "demo_accounts_enabled": s.demo_accounts_enabled,
            "tool_transport": runtime_settings.get_section(db, "demo")["tool_transport"], "worker": worker.status(),
            "default_mode": "live" if s.llm_configured else "demo",
            "it_tools": "sandbox (simulated devices, accounts and printers)"}
