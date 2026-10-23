"""ORM models. All timestamps are stored in UTC; IDs are prefixed and time-sortable."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, event
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime, new_id, utcnow


def _id(prefix: str):
    return mapped_column(String(40), primary_key=True, default=lambda: new_id(prefix))


def _created():
    return mapped_column(UTCDateTime(), default=utcnow, nullable=False)


def _updated():
    return mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow, nullable=False)


# --------------------------------------------------------------------------- users & auth
class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = _id("usr")
    email: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)  # employee | engineer | admin
    department: Mapped[str | None] = mapped_column(String(80))
    password_hash: Mapped[str] = mapped_column(String(300), nullable=False)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    preferences: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = _created()


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    id: Mapped[str] = _id("ses")
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = _created()
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


# --------------------------------------------------------------------------- tickets
class Ticket(Base):
    __tablename__ = "tickets"
    id: Mapped[str] = _id("tkt")
    number: Mapped[int] = mapped_column(Integer, unique=True, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(String(40), nullable=False)
    priority: Mapped[str] = mapped_column(String(10), nullable=False)  # low | medium | high | critical
    # open | in_progress | waiting_on_user | pending_approval | escalated | resolved | closed | cancelled
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="open")
    requester_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    assignee_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    workflow_id: Mapped[str | None] = mapped_column(String(40))
    idempotency_key: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    origin: Mapped[str] = mapped_column(String(10), default="live")  # live | seed | eval
    resolution: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()
    resolved_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


# --------------------------------------------------------------------------- conversations
class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[str] = _id("cnv")
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    workflow_id: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[datetime] = _created()


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[str] = _id("msg")
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    author_role: Mapped[str] = mapped_column(String(16), nullable=False)  # user | assistant | engineer | system
    author_id: Mapped[str | None] = mapped_column(String(40))
    kind: Mapped[str] = mapped_column(String(24), default="text")  # text | clarification | confirmation | recommendation | notice
    content: Mapped[str] = mapped_column(Text, nullable=False)
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = _created()


# --------------------------------------------------------------------------- workflows
class WorkflowRun(Base):
    __tablename__ = "workflow_runs"
    id: Mapped[str] = _id("wf")
    requester_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    ticket_id: Mapped[str | None] = mapped_column(ForeignKey("tickets.id"))
    conversation_id: Mapped[str | None] = mapped_column(String(40))
    idempotency_key: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    original_request: Mapped[str] = mapped_column(Text, nullable=False)
    mode: Mapped[str] = mapped_column(String(10), nullable=False)  # demo | live
    origin: Mapped[str] = mapped_column(String(10), default="live")  # live | seed | eval
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="received")
    category: Mapped[str | None] = mapped_column(String(40))
    priority: Mapped[str | None] = mapped_column(String(10))
    current_step: Mapped[int] = mapped_column(Integer, default=0)
    plan_summary: Mapped[str | None] = mapped_column(Text)
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    risk: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    verification: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # classification, pending question, options
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)  # checkpoint version, bumped on each transition
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    automation_paused: Mapped[bool] = mapped_column(Boolean, default=False)
    taken_over_by: Mapped[str | None] = mapped_column(String(40))
    error: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    active_ms: Mapped[int] = mapped_column(Integer, default=0)  # automated processing time, excludes waiting
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    model_config_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class WorkflowStep(Base):
    """A plan step. Plan steps are schema-validated before they are persisted."""

    __tablename__ = "workflow_steps"
    __table_args__ = (UniqueConstraint("workflow_id", "step_key", name="uq_step_key"),)
    id: Mapped[str] = _id("stp")
    workflow_id: Mapped[str] = mapped_column(ForeignKey("workflow_runs.id", ondelete="CASCADE"), nullable=False)
    step_key: Mapped[str] = mapped_column(String(20), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    tool: Mapped[str] = mapped_column(String(60), nullable=False)
    arguments: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    depends_on: Mapped[list[str]] = mapped_column(JSON, default=list)
    rationale: Mapped[str | None] = mapped_column(Text)
    # pending | running | done | failed | skipped | awaiting_approval | blocked
    status: Mapped[str] = mapped_column(String(20), default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    result_summary: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class WorkflowEvent(Base):
    """Observable event stream. The integer id doubles as the SSE event id (Last-Event-ID)."""

    __tablename__ = "workflow_events"
    __table_args__ = (Index("ix_events_wf", "workflow_id", "id"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workflow_id: Mapped[str] = mapped_column(ForeignKey("workflow_runs.id", ondelete="CASCADE"), nullable=False)
    type: Mapped[str] = mapped_column(String(40), nullable=False)
    stage: Mapped[str | None] = mapped_column(String(32))
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    simulated: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = _created()


class Job(Base):
    """Durable work queue. Survives restarts; running jobs are re-queued on startup."""

    __tablename__ = "jobs"
    id: Mapped[str] = _id("job")
    workflow_id: Mapped[str | None] = mapped_column(String(40))
    kind: Mapped[str] = mapped_column(String(20), nullable=False)  # advance | evaluation
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(12), default="queued")  # queued | running | done | failed
    dedupe_key: Mapped[str | None] = mapped_column(String(120), unique=True)
    run_after: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    locked_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = _created()


# --------------------------------------------------------------------------- tools
class ToolCall(Base):
    __tablename__ = "tool_calls"
    id: Mapped[str] = _id("tc")
    workflow_id: Mapped[str | None] = mapped_column(String(40), index=True)
    step_id: Mapped[str | None] = mapped_column(String(40))
    tool_name: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    arguments: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # sanitised
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    # success | error | blocked | timeout | needs_approval | running | interrupted
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    error_kind: Mapped[str | None] = mapped_column(String(20))  # transient | permanent | validation | policy | timeout
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    transport: Mapped[str] = mapped_column(String(12), default="in_process")  # in_process | mcp
    simulated: Mapped[bool] = mapped_column(Boolean, default=True)
    policy_decision: Mapped[str | None] = mapped_column(String(20))
    idempotency_key: Mapped[str | None] = mapped_column(String(120))
    created_at: Mapped[datetime] = _created()


class SandboxResource(Base):
    """Simulated device / account / printer state. Nothing here touches a real machine."""

    __tablename__ = "sandbox_resources"
    id: Mapped[str] = mapped_column(String(60), primary_key=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)  # laptop | account | printer | mailbox
    owner_id: Mapped[str | None] = mapped_column(String(40))
    workflow_id: Mapped[str | None] = mapped_column(String(40))
    state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


# --------------------------------------------------------------------------- approvals
class ApprovalRequest(Base):
    __tablename__ = "approval_requests"
    id: Mapped[str] = _id("apr")
    workflow_id: Mapped[str] = mapped_column(ForeignKey("workflow_runs.id", ondelete="CASCADE"), nullable=False)
    step_id: Mapped[str] = mapped_column(String(40), nullable=False)
    ticket_id: Mapped[str | None] = mapped_column(String(40))
    requester_id: Mapped[str] = mapped_column(String(40), nullable=False)
    tool_name: Mapped[str] = mapped_column(String(60), nullable=False)
    action: Mapped[str] = mapped_column(String(60), nullable=False)
    action_summary: Mapped[str] = mapped_column(Text, nullable=False)
    target_resource: Mapped[str] = mapped_column(String(120), nullable=False)
    parameters: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    params_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    action_version: Mapped[int] = mapped_column(Integer, default=1)
    risk_level: Mapped[str] = mapped_column(String(10), nullable=False)
    policy_id: Mapped[str] = mapped_column(String(40), nullable=False)
    policy_text: Mapped[str] = mapped_column(Text, nullable=False)
    approver_roles: Mapped[list[str]] = mapped_column(JSON, default=list)
    reason_required: Mapped[bool] = mapped_column(Boolean, default=False)
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    expected_effect: Mapped[str] = mapped_column(Text, nullable=False)
    # pending | approved | executing | executed | rejected | info_requested | invalidated | cancelled
    status: Mapped[str] = mapped_column(String(16), default="pending")
    decided_by: Mapped[str | None] = mapped_column(String(40))
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    decision_reason: Mapped[str | None] = mapped_column(Text)
    executed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    origin: Mapped[str] = mapped_column(String(10), default="live")
    created_at: Mapped[datetime] = _created()


class ApprovalDecision(Base):
    __tablename__ = "approval_decisions"
    id: Mapped[str] = _id("dec")
    approval_id: Mapped[str] = mapped_column(ForeignKey("approval_requests.id", ondelete="CASCADE"), nullable=False)
    reviewer_id: Mapped[str] = mapped_column(String(40), nullable=False)
    reviewer_role: Mapped[str] = mapped_column(String(20), nullable=False)
    decision: Mapped[str] = mapped_column(String(16), nullable=False)  # approve | reject | request_info | edit
    reason: Mapped[str | None] = mapped_column(Text)
    params_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = _created()


# --------------------------------------------------------------------------- knowledge
class KnowledgeDocument(Base):
    __tablename__ = "knowledge_documents"
    id: Mapped[str] = _id("kb")
    slug: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False)  # seed | upload
    filename: Mapped[str | None] = mapped_column(String(200))
    content_type: Mapped[str] = mapped_column(String(40), nullable=False)  # markdown | text | pdf
    version: Mapped[int] = mapped_column(Integer, default=1)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    category: Mapped[str | None] = mapped_column(String(40))
    # indexed | ocr_required | failed | archived
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    status_detail: Mapped[str | None] = mapped_column(Text)
    content_text: Mapped[str] = mapped_column(Text, default="")
    content_hash: Mapped[str | None] = mapped_column(String(64))
    trust_flags: Mapped[list[str]] = mapped_column(JSON, default=list)
    storage_path: Mapped[str | None] = mapped_column(String(300))
    uploaded_by: Mapped[str | None] = mapped_column(String(40))
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    indexed_backend: Mapped[str | None] = mapped_column(String(16))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


class KnowledgeChunk(Base):
    __tablename__ = "knowledge_chunks"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)  # <doc_id>:v<version>:c<index>
    document_id: Mapped[str] = mapped_column(ForeignKey("knowledge_documents.id", ondelete="CASCADE"), index=True)
    document_version: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    heading: Mapped[str | None] = mapped_column(String(200))
    text: Mapped[str] = mapped_column(Text, nullable=False)
    char_start: Mapped[int] = mapped_column(Integer, default=0)
    char_end: Mapped[int] = mapped_column(Integer, default=0)
    flags: Mapped[list[str]] = mapped_column(JSON, default=list)


# --------------------------------------------------------------------------- notifications
class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[str] = _id("ntf")
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    type: Mapped[str] = mapped_column(String(30), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(Text, default="")
    link: Mapped[str | None] = mapped_column(String(200))
    read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = _created()


# --------------------------------------------------------------------------- audit (append-only)
class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor_id: Mapped[str | None] = mapped_column(String(40), index=True)
    actor_name: Mapped[str | None] = mapped_column(String(120))
    actor_role: Mapped[str] = mapped_column(String(20), nullable=False)  # employee | engineer | admin | agent | system
    action: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    resource_type: Mapped[str] = mapped_column(String(30), nullable=False)
    resource_id: Mapped[str | None] = mapped_column(String(80))
    workflow_id: Mapped[str | None] = mapped_column(String(40), index=True)
    ticket_id: Mapped[str | None] = mapped_column(String(40))
    outcome: Mapped[str] = mapped_column(String(12), nullable=False)  # success | denied | failure
    details: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    origin: Mapped[str] = mapped_column(String(10), default="live")
    created_at: Mapped[datetime] = _created()


@event.listens_for(AuditEvent, "before_update")
def _audit_no_update(*_):
    raise RuntimeError("audit_events is append-only")


@event.listens_for(AuditEvent, "before_delete")
def _audit_no_delete(*_):
    raise RuntimeError("audit_events is append-only")


# --------------------------------------------------------------------------- evaluation
class EvaluationCase(Base):
    __tablename__ = "evaluation_cases"
    __table_args__ = (UniqueConstraint("dataset_version", "key", name="uq_eval_case"),)
    id: Mapped[str] = _id("evc")
    dataset_version: Mapped[str] = mapped_column(String(20), nullable=False)
    key: Mapped[str] = mapped_column(String(60), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    input_text: Mapped[str] = mapped_column(Text, nullable=False)
    expected: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    harness: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # reviewer decision, fault injection, ...


class EvaluationRun(Base):
    __tablename__ = "evaluation_runs"
    id: Mapped[str] = _id("evr")
    dataset_version: Mapped[str] = mapped_column(String(20), nullable=False)
    mode: Mapped[str] = mapped_column(String(10), nullable=False)
    systems: Mapped[list[str]] = mapped_column(JSON, default=list)
    model_config_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(12), default="queued")  # queued | running | completed | failed
    summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(40), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = _created()


class EvaluationResult(Base):
    __tablename__ = "evaluation_results"
    id: Mapped[str] = _id("evx")
    run_id: Mapped[str] = mapped_column(ForeignKey("evaluation_runs.id", ondelete="CASCADE"), index=True)
    case_id: Mapped[str] = mapped_column(String(40), nullable=False)
    case_key: Mapped[str] = mapped_column(String(60), nullable=False)
    system: Mapped[str] = mapped_column(String(12), nullable=False)  # baseline | agent
    outcome: Mapped[str] = mapped_column(String(32), nullable=False)
    passed: Mapped[bool] = mapped_column(Boolean, default=False)
    checks: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    claims: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    tools_called: Mapped[list[str]] = mapped_column(JSON, default=list)
    workflow_id: Mapped[str | None] = mapped_column(String(40))
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = _created()


# --------------------------------------------------------------------------- configuration
class IntegrationConfig(Base):
    __tablename__ = "integration_configs"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)  # jira | slack | teams | email | monitoring
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="not_configured")  # not_configured | configured | error
    implemented: Mapped[bool] = mapped_column(Boolean, default=False)
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # non-secret metadata only
    updated_at: Mapped[datetime] = _updated()


class AppSetting(Base):
    __tablename__ = "app_settings"
    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    updated_by: Mapped[str | None] = mapped_column(String(40))
    updated_at: Mapped[datetime] = _updated()
