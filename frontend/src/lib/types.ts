// Mirrors backend/app/schemas.py and the payloads built in backend/app/serialize.py.

export type Role = "employee" | "engineer" | "admin";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  department: string | null;
  is_demo: boolean;
  preferences?: { notifications?: Record<string, boolean> };
}

export type WorkflowStatus =
  | "received" | "classifying" | "retrieving" | "planning" | "diagnosing" | "awaiting_approval" | "executing"
  | "verifying" | "completed" | "awaiting_user_input" | "awaiting_human_review" | "escalated" | "failed"
  | "cancelled" | "blocked";

export type TicketStatus =
  | "open" | "in_progress" | "waiting_on_user" | "pending_approval" | "escalated" | "resolved" | "closed" | "cancelled";

export interface Ticket {
  id: string;
  number: number;
  display_id: string;
  title: string;
  description: string;
  category: string;
  priority: string;
  status: TicketStatus;
  requester_id: string;
  assignee_id: string | null;
  workflow_id: string | null;
  origin: string;
  resolution: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  requester: User | null;
  assignee: User | null;
  workflow_status: WorkflowStatus | null;
}

export interface WorkflowSummary {
  id: string;
  requester_id: string;
  ticket_id: string | null;
  original_request: string;
  mode: "demo" | "live";
  origin: "live" | "seed" | "eval";
  status: WorkflowStatus;
  category: string | null;
  priority: string | null;
  retry_count: number;
  version: number;
  automation_paused: boolean;
  taken_over_by: string | null;
  active_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  ticket_number: number | null;
  requester_name: string | null;
}

export interface Step {
  id: string;
  step_key: string;
  position: number;
  title: string;
  tool: string;
  arguments: Record<string, unknown>;
  depends_on: string[];
  rationale: string | null;
  status: "pending" | "running" | "done" | "failed" | "skipped" | "awaiting_approval" | "blocked";
  attempts: number;
  result_summary: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface ToolCall {
  id: string;
  workflow_id: string | null;
  step_id: string | null;
  tool_name: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: "success" | "error" | "blocked" | "timeout" | "needs_approval" | "running" | "interrupted";
  error: string | null;
  error_kind: string | null;
  attempt: number;
  duration_ms: number;
  transport: "in_process" | "mcp";
  simulated: boolean;
  policy_decision: string | null;
  created_at: string;
}

export interface WorkflowEvent {
  id: number;
  workflow_id: string;
  type: string;
  stage: string | null;
  summary: string;
  data: Record<string, unknown>;
  simulated: boolean;
  created_at: string;
}

export interface Message {
  id: string;
  author_role: "user" | "assistant" | "engineer" | "system";
  author_id: string | null;
  author_name?: string | null;
  kind: "text" | "clarification" | "confirmation" | "recommendation" | "notice";
  content: string;
  meta: {
    citations?: Citation[];
    suggestions?: string[];
    missing?: string[];
    policies?: string[];
    redacted?: string[];
  };
  created_at: string;
}

export interface Citation {
  chunk_id: string;
  title: string;
  document_id: string;
  version: number;
}

export interface Evidence {
  chunk_id: string;
  document_id: string;
  slug: string;
  title: string;
  category: string | null;
  version: number;
  heading: string | null;
  snippet: string;
  relevance: number;
  above_threshold: boolean;
  trust: "standard" | "untrusted_instructions";
  source: string;
  retrieval?: string;
}

export interface Approval {
  id: string;
  workflow_id: string;
  step_id: string;
  ticket_id: string | null;
  requester_id: string;
  tool_name: string;
  action: string;
  action_summary: string;
  target_resource: string;
  parameters: Record<string, unknown>;
  params_hash: string;
  action_version: number;
  risk_level: "low" | "medium" | "high" | "critical";
  policy_id: string;
  policy_text: string;
  approver_roles: string[];
  reason_required: boolean;
  evidence: Array<{
    kind: "diagnosis" | "kb";
    text?: string;
    verifier?: { supported?: boolean; detail?: string };
    chunk_id?: string;
    document_id?: string;
    title?: string;
    version?: number;
    relevance?: number;
    snippet?: string;
  }>;
  expected_effect: string;
  status: "pending" | "approved" | "executing" | "executed" | "rejected" | "info_requested" | "invalidated" | "cancelled";
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  executed_at: string | null;
  origin: string;
  created_at: string;
  requester_name: string | null;
  decided_by_name: string | null;
  ticket_number: number | null;
  request_text: string | null;
  can_decide: boolean;
}

export interface Classification {
  category: string;
  priority: string;
  title: string;
  summary: string;
  missing_information: string[];
  clarifying_question: string | null;
  unsafe: Array<{ action_class: string; reason: string }>;
  method: string;
  model: string | null;
}

export interface WorkflowDetail {
  workflow: WorkflowSummary;
  state: {
    classification?: Classification | null;
    pending_question?: { kind: string; question: string } | null;
    diagnosis?: {
      finding: string;
      action: string | null;
      target_id: string | null;
      human_review: boolean;
      reason: string;
      method: string;
      verifier: { supported: boolean; detail: string };
    } | null;
    review?: { reason: string; group: string; severity?: string } | null;
    sandbox?: { device_id: string; account_id: string; printer_id: string; fixture: string } | null;
    faults?: { ticketing: string; verification: string } | null;
    escalation?: { group: string; reason: string } | null;
    offer_demo_run?: boolean | null;
    plan_revision?: number | null;
    clarification_rounds?: number | null;
    redactions?: string[] | null;
  };
  plan_summary: string | null;
  evidence: Evidence[];
  risk: { policy_id?: string; requires_approval?: boolean };
  verification: {
    verified?: boolean;
    check?: string;
    method?: string;
    observations?: Record<string, unknown>;
    verified_at?: string;
    user_confirmed?: boolean;
    note?: string;
  };
  error: { code: string; message: string; retryable: boolean } | null;
  model_config: Record<string, unknown>;
  steps: Step[];
  tool_calls: ToolCall[];
  approvals: Approval[];
  events: WorkflowEvent[];
  messages: Message[];
  ticket: Ticket | null;
  taken_over_by: User | null;
  available_actions: string[];
  terminal: boolean;
  waiting: boolean;
}

export interface SystemStatus {
  app_env: string;
  llm_configured: boolean;
  retrieval_backend: string;
  retrieval_label: string;
  demo_accounts_enabled: boolean;
  tool_transport: "in_process" | "mcp";
  worker: { alive: boolean; last_heartbeat_age_s: number | null };
  default_mode: "demo" | "live";
  it_tools: string;
}

export interface KnowledgeDoc {
  id: string;
  slug: string;
  title: string;
  source: string;
  filename: string | null;
  content_type: string;
  version: number;
  tags: string[];
  category: string | null;
  status: "indexed" | "ocr_required" | "failed" | "archived";
  status_detail: string | null;
  trust_flags: string[];
  chunk_count: number;
  indexed_backend: string | null;
  created_at: string;
  updated_at: string;
}

export interface Chunk {
  id: string;
  document_version: number;
  chunk_index: number;
  heading: string | null;
  text: string;
  char_start: number;
  char_end: number;
  flags: string[];
}

export interface SearchResult {
  query: string;
  backend: string;
  backend_label: string;
  min_relevance: number;
  results: Evidence[];
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  created_at: string;
}

export interface AuditEvent {
  id: number;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  workflow_id: string | null;
  ticket_id: string | null;
  outcome: "success" | "denied" | "failure";
  details: Record<string, unknown>;
  origin: string;
  created_at: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface Rate {
  value: number | null;
  numerator?: number;
  denominator?: number;
  not_applicable?: boolean;
}
