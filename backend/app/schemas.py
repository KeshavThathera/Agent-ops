"""Pydantic request/response schemas. frontend/src/lib/types.ts mirrors these."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ------------------------------------------------------------------ requests
class LoginIn(BaseModel):
    email: str = Field(max_length=200)
    password: str = Field(max_length=200)


class DemoLoginIn(BaseModel):
    email: str = Field(max_length=200)


class SubmitRequestIn(BaseModel):
    text: str = Field(min_length=3, max_length=2000)
    mode: Literal["demo", "live"] = "demo"
    idempotency_key: str = Field(min_length=8, max_length=80, pattern=r"^[A-Za-z0-9_\-:.]+$")
    demo_options: dict[Literal["ticketing_fault", "verification_fault"], str] | None = None


class MessageIn(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


class WorkflowActionIn(BaseModel):
    action: Literal["cancel", "retry", "resume", "takeover", "release", "escalate", "resolve", "request_info", "confirm_fix", "reopen"]
    reason: str | None = Field(default=None, max_length=1000)
    message: str | None = Field(default=None, max_length=1000)
    group: Literal["service_desk", "network_team", "identity_team", "collaboration_team", "hardware_onsite", "security"] | None = None
    verification_note: str | None = Field(default=None, max_length=1000)


class ApprovalDecisionIn(BaseModel):
    decision: Literal["approve", "reject", "request_info"]
    reason: str | None = Field(default=None, max_length=1000)
    params_hash: str = Field(min_length=64, max_length=64)


class ApprovalEditIn(BaseModel):
    parameters: dict[str, str | bool | int]
    reason: str = Field(min_length=3, max_length=1000)


class TicketPatchIn(BaseModel):
    priority: Literal["low", "medium", "high", "critical"] | None = None
    assignee_id: str | None = Field(default=None, max_length=40)
    unassign: bool = False
    reason: str | None = Field(default=None, max_length=500)


class KnowledgeSearchIn(BaseModel):
    query: str = Field(min_length=2, max_length=500)
    top_k: int | None = Field(default=None, ge=1, le=10)
    backend: Literal["keyword", "chroma"] | None = None


class EvaluationRunIn(BaseModel):
    mode: Literal["demo", "live"] = "demo"
    systems: list[Literal["baseline", "agent"]] = Field(default_factory=lambda: ["baseline", "agent"], min_length=1)


class ResetIn(BaseModel):
    confirm: str


class MarkReadIn(BaseModel):
    ids: list[str] | None = Field(default=None, max_length=100)


# ------------------------------------------------------------------ responses
class UserOut(Out):
    id: str
    email: str
    name: str
    role: str
    department: str | None = None
    is_demo: bool = False


class TicketOut(Out):
    id: str
    number: int
    title: str
    description: str
    category: str
    priority: str
    status: str
    requester_id: str
    assignee_id: str | None
    workflow_id: str | None
    origin: str
    resolution: str | None
    created_at: datetime
    updated_at: datetime
    resolved_at: datetime | None
    requester: UserOut | None = None
    assignee: UserOut | None = None
    workflow_status: str | None = None


class WorkflowSummaryOut(Out):
    id: str
    requester_id: str
    ticket_id: str | None
    original_request: str
    mode: str
    origin: str
    status: str
    category: str | None
    priority: str | None
    retry_count: int
    version: int
    automation_paused: bool
    taken_over_by: str | None
    active_ms: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None
    ticket_number: int | None = None
    requester_name: str | None = None


class StepOut(Out):
    id: str
    step_key: str
    position: int
    title: str
    tool: str
    arguments: dict[str, Any]
    depends_on: list[str]
    rationale: str | None
    status: str
    attempts: int
    result_summary: str | None
    started_at: datetime | None
    finished_at: datetime | None


class ToolCallOut(Out):
    id: str
    workflow_id: str | None
    step_id: str | None
    tool_name: str
    arguments: dict[str, Any]
    result: dict[str, Any] | None
    status: str
    error: str | None
    error_kind: str | None
    attempt: int
    duration_ms: int
    transport: str
    simulated: bool
    policy_decision: str | None
    created_at: datetime


class EventOut(Out):
    id: int
    workflow_id: str
    type: str
    stage: str | None
    summary: str
    data: dict[str, Any]
    simulated: bool
    created_at: datetime


class MessageOut(Out):
    id: str
    author_role: str
    author_id: str | None
    kind: str
    content: str
    meta: dict[str, Any]
    created_at: datetime


class ApprovalOut(Out):
    id: str
    workflow_id: str
    step_id: str
    ticket_id: str | None
    requester_id: str
    tool_name: str
    action: str
    action_summary: str
    target_resource: str
    parameters: dict[str, Any]
    params_hash: str
    action_version: int
    risk_level: str
    policy_id: str
    policy_text: str
    approver_roles: list[str]
    reason_required: bool
    evidence: list[dict[str, Any]]
    expected_effect: str
    status: str
    decided_by: str | None
    decided_at: datetime | None
    decision_reason: str | None
    executed_at: datetime | None
    origin: str
    created_at: datetime
    requester_name: str | None = None
    decided_by_name: str | None = None
    ticket_number: int | None = None
    request_text: str | None = None
    can_decide: bool = False


class DocumentOut(Out):
    id: str
    slug: str
    title: str
    source: str
    filename: str | None
    content_type: str
    version: int
    tags: list[str]
    category: str | None
    status: str
    status_detail: str | None
    trust_flags: list[str]
    chunk_count: int
    indexed_backend: str | None
    created_at: datetime
    updated_at: datetime


class ChunkOut(Out):
    id: str
    document_version: int
    chunk_index: int
    heading: str | None
    text: str
    char_start: int
    char_end: int
    flags: list[str]


class NotificationOut(Out):
    id: str
    type: str
    title: str
    body: str
    link: str | None
    read: bool
    created_at: datetime


class AuditOut(Out):
    id: int
    actor_id: str | None
    actor_name: str | None
    actor_role: str
    action: str
    resource_type: str
    resource_id: str | None
    workflow_id: str | None
    ticket_id: str | None
    outcome: str
    details: dict[str, Any]
    origin: str
    created_at: datetime


class Page(BaseModel):
    items: list[Any]
    total: int
    page: int
    page_size: int
