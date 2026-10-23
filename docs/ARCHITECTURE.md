# Architecture

## Six layers

| # | Layer | Implementation |
|---|---|---|
| 1 | Interaction | Next.js 16 console (`frontend/src/app/(console)`), chat is one view among tickets, approvals, traces |
| 2 | Orchestration | Persisted state machine `backend/app/engine.py`, durable job queue `worker.py`, SSE in `routes_core.py` |
| 3 | Reasoning | `agent.py`: classification, missing-info detection, diagnostic planning, diagnosis, deterministic verifier |
| 4 | Knowledge (RAG) | `rag.py`: ingestion, chunking, injection flags, TF-IDF or ChromaDB retrieval |
| 5 | Tools & integrations | `tools.py` registry + execution pipeline, `sandbox.py`, `mcp_server.py` / `mcp_client.py` |
| 6 | Governance & observability | `policy.py`, approvals in `engine.py`, `audit.py`, `evaluation.py`, `events.py` |

```
Browser ──► Next.js (UI, /api proxy) ──► FastAPI ──► SQLite/PostgreSQL
                                           │  ├─ worker thread ─► engine.advance(workflow)
                                           │  │                     ├─ agent (demo rules | Claude)
                                           │  │                     ├─ tools.run_tool ─► policy ─► sandbox / ticketing
                                           │  │                     │                         └─► MCP client ─stdio─► app.mcp_server
                                           │  │                     └─ events / audit / notifications
                                           │  └─ SSE: GET /api/workflows/{id}/events (Last-Event-ID resume)
```

## Logical agent responsibilities (nodes in one graph, not separate autonomous processes)

- **Planning** — `h_classifying`, `h_planning`: interpret the request, detect missing details, produce schema-valid
  diagnostic steps restricted to allow-listed read-only tools.
- **Knowledge** — `h_retrieving` and a second, targeted retrieval in `_diagnose` once the fix is known.
- **Execution** — `h_steps` / `_run_step`: validate args, apply policy, bind approvals, execute, persist.
- **Verification** — `agent.verify_diagnosis` rejects remediations not supported by observed diagnostics;
  `verify_resolution` re-runs diagnostics; the ticket is resolved only when verification passes (or the
  requester confirms, for subjective outcomes, or a technician attests with evidence).

Deterministic code owns permissions, approvals, state transitions and completion checks. The model (live mode)
only proposes classifications, diagnostic plans and diagnoses, all schema-validated and verifier-checked.

## State machine

```
received → classifying → retrieving → planning → diagnosing → awaiting_approval → executing → verifying → completed
                │              │                       │               │                         │
                ├─ blocked     ├─ awaiting_human_review ├─ awaiting_human_review (verifier rejects, hardware, no fix)
                └─ awaiting_user_input (clarification)  │               └─ rejected → awaiting_human_review
                                                        └─ failed (retries exhausted, LLM error) ─ retry ─► resume stage
Any non-terminal state → cancelled.  awaiting_human_review → escalated | completed (technician-attested) | awaiting_user_input.
```

Terminal: `completed, escalated, failed, cancelled, blocked`. Waiting: `awaiting_approval, awaiting_user_input,
awaiting_human_review`. Each transition increments `workflow_runs.version` (the checkpoint number) and writes a
`stage_changed` event.

### Durability and recovery
- `engine.advance` runs one node or one plan step per transaction; every commit is a checkpoint.
- Jobs live in the `jobs` table. On start, `worker.recover()` re-queues jobs left `running` and enqueues workflows
  stuck in an active state without a job.
- Side effects carry idempotency keys: `ticket:<workflow>` for ticket creation, `approval:<approval>` for
  remediations. Sandbox remediations record applied keys, so a replay returns `idempotent_replay: true`.
- Approvals are claimed with conditional `UPDATE … WHERE status='approved'` (→ `executing` → `executed`);
  decisions with `UPDATE … WHERE status='pending' AND params_hash=?`, so double clicks cannot double-decide.

### Retries
Transient tool errors (`ToolError(kind="transient")`) on idempotent tools are retried with exponential backoff
(`retry` settings; default 3 attempts, 0.4 s base, persisted as delayed jobs). Validation, policy and permanent
errors are never retried automatically. After the budget, the workflow fails with `retryable=true` only if the
failed step is idempotent, enabling an engineer's manual retry. Live-model output gets exactly one repair attempt.

## Approval binding
`params_hash = sha256({workflow, step, tool, args, action_version})`. The reviewer's decision must include the
hash they saw. Editing parameters invalidates the request and creates `action_version+1`. Before execution the
engine recomputes the hash from the current step arguments; a mismatch invalidates the approval and requests a new
one. Rejection skips the step and routes to human review. Requesters cannot approve their own requests.

## Policy (enforced in `tools.run_tool`, outside the model)

| Action class | Decision | Approvers |
|---|---|---|
| kb_read, device_read, diagnostic_readonly, ticket_write, recommendation, human_review_request | automatic | — |
| device_config_change (editable: automatic/approval) | approval required | engineer, admin |
| account_change | approval required, reason required | engineer, admin |
| external_notification (editable: approval/unavailable) | approval required | engineer, admin |
| record_delete, arbitrary_command, policy_bypass, unclassified/unknown tools | unavailable | — |

`request_human_review` is always automatic, so the system can always pause safely without needing approval to do so.

## Retrieval and grounding
- Chunking: split by Markdown headings, pack paragraphs ≤ 900 chars; chunk id `<doc>:v<version>:c<index>`.
- Replace/reindex deletes old chunks (and vectors) in the same transaction; results drop chunks whose version
  differs from the document's current version.
- Relevance is cosine similarity (TF-IDF or MiniLM), shown as such — never as confidence.
- Instruction-like text (e.g. “ignore previous instructions”, “bypass approval”) flags a chunk as
  `untrusted_instructions`: shown with a warning, excluded from grounding, unable to affect policy.
- A recommendation is grounded only if it cites a trusted, above-threshold chunk from an article whose topic matches
  the remediation; otherwise the case goes to human review rather than inventing guidance.

## Data model (tables)
`users, auth_sessions, tickets, conversations, messages, workflow_runs, workflow_steps, workflow_events, jobs,
tool_calls, sandbox_resources, approval_requests, approval_decisions, knowledge_documents, knowledge_chunks,
notifications, audit_events, evaluation_cases, evaluation_runs, evaluation_results, integration_configs,
app_settings`. Timestamps are stored in UTC and displayed in the browser's locale. Migration:
`backend/migrations/versions/0001_initial_schema.py`.

## API (all under `/api`, JSON errors as `{"error": {"code", "message", "details"}}`)

| Area | Endpoints |
|---|---|
| Auth | `GET auth/config`, `POST auth/login`, `POST auth/demo-login`*, `POST auth/logout`, `GET me`, `GET users` |
| Requests & workflows | `POST requests`, `GET workflows`, `GET workflows/{id}`, `GET workflows/{id}/events` (SSE), `POST workflows/{id}/messages`, `POST workflows/{id}/actions`, `POST workflows/{id}/demo-rerun` |
| Approvals | `GET approvals`, `GET approvals/{id}`, `POST approvals/{id}/decision`, `POST approvals/{id}/parameters` |
| Tickets | `GET tickets` (search/filter/sort/paginate), `GET tickets/{id}`, `PATCH tickets/{id}` |
| Knowledge | `GET knowledge`, `GET knowledge/{id}`, `GET knowledge/{id}/file`, `POST knowledge/search`, `POST knowledge/upload`, `POST knowledge/{id}/replace`, `POST knowledge/{id}/reindex`, `POST knowledge/{id}/archive` |
| Tools | `GET tools`, `GET tools/{name}/calls`, `POST tools/mcp/probe`, `GET integrations` |
| Evaluation | `GET evaluations`, `POST evaluations/runs`, `GET evaluations/runs/{id}`, `GET evaluations/runs/{id}/export?format=csv|json` |
| Governance | `GET audit`, `GET dashboard`, `GET/PUT settings/{section}`, `PUT me/preferences`, `POST admin/reset-demo`*, `GET system/status`, `GET notifications`, `POST notifications/read` |

\* only when `DEMO_ACCOUNTS_ENABLED=true`.

## Security controls
- Server-side sessions: random token in an httpOnly, SameSite=Lax cookie; SHA-256 of the token stored.
- CSRF: state-changing calls must send `X-Requested-With: agentops-desk` (cross-site requests cannot without CORS).
- RBAC + ownership on every endpoint, including the SSE stream and uploaded files; unrelated users get 404.
- Strict Pydantic input models (extra fields forbidden) for API bodies and every tool.
- Redaction of passwords, API keys, bearer tokens, card-like and 12-digit ID numbers in messages, tool args and audit.
- Upload type sniffing, size limit, PDF text-layer check; KB content rendered without `innerHTML`.
- Rate limits (sign-in, request submission), execution budgets (steps, automated seconds), MCP call timeouts.
- No shell execution and no real device mutation anywhere in the code base.

## Substitutions (and why)
1. **SQLite instead of PostgreSQL by default.** The development machine had no PostgreSQL and the Docker daemon was
   not running. The ORM, migrations and JSON columns are database-agnostic; Compose wires PostgreSQL.
2. **Custom state machine instead of LangGraph.** Approvals, idempotency keys, job queue and audit must commit in the
   same transaction as application data; a second checkpoint store would duplicate state and complicate recovery.
   The engine still models the workflow as nodes with explicit transitions and checkpoints.
