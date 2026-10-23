# AgentOps Desk

**Agentic AI IT Operations & Support Platform** — final-year project prototype for
*“Agentic AI Workflow Automation for Intelligent Business Process Management”*
(Engineering College Bikaner, Bikaner Technical University, 2026–27).

An employee reports an IT problem; the system classifies it, retrieves knowledge-base evidence, plans and runs
sandboxed diagnostics, creates a ticket, recommends a grounded fix, pauses for human approval when policy
requires it, executes only approved actions, verifies the result, and resolves the ticket only when
verification passes. Every step is persisted, streamed live to the UI and recorded in an audit trail.

> The original project reports were not available while this was built; the implementation follows the written
> specification. Nothing in the app presents unverified claims from the reports as facts.

---

## Quick start (Windows, macOS, Linux)

Requirements: **Python 3.12+** (tested on 3.13), **Node.js 20+** (tested on 22). No API keys needed.

```bash
# 1. Backend
cd backend
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env             # macOS/Linux: cp .env.example .env
python -m app.cli init             # migrations + seed (users, 14 KB articles, 6 demo workflows)
uvicorn app.main:app --port 8000
```

```bash
# 2. Frontend (second terminal)
cd frontend
npm install
npm run dev                        # http://localhost:3000
```

Open http://localhost:3000 and use a **demo account** button on the sign-in page
(password for all: `demo-pass-2026`). Demo accounts exist only because `DEMO_ACCOUNTS_ENABLED=true`.

| Account | Role | Use it to |
|---|---|---|
| Riya Mehta, Arjun Verma | Employee | Submit requests, answer questions, confirm fixes |
| Sana Khan, Vikram Rao | Support engineer | Approve/reject, take over, escalate, resolve |
| Neha Joshi | Administrator | Dashboard, KB uploads, policies, audit, evaluation, settings |

Useful commands:

```bash
python -m app.cli reset            # wipe the local SQLite DB, uploads and vector index, then re-seed
python -m app.cli seed --no-workflows   # reference data only (idempotent)
python -m app.mcp_server           # run the MCP server standalone (stdio)
```

### Optional: live LLM mode
Set `ANTHROPIC_API_KEY` in `backend/.env` and restart. The request form then offers **Live LLM run**:
Claude classifies the request, plans diagnostics and interprets results (structured output validated by
Pydantic, one repair attempt). Defaults: `claude-haiku-5-5` for classification, `claude-opus-5-5` for
planning/diagnosis (change via env or Settings → Model routing). The server-side refusal fallback
(`LLM_REFUSAL_FALLBACK=true`) is enabled by default for supported models. Live runs incur API cost.
**Live mode was implemented but not executed here (no key available);** its logic is covered by tests with a
mocked model. A live failure never silently becomes a demo run — the UI offers an explicit “Start a separate demo run”.

### Optional: vector retrieval
```bash
pip install -r requirements-optional.txt
# backend/.env: RETRIEVAL_BACKEND=chroma
python -m app.cli reset            # re-index the KB into ChromaDB (downloads ~80 MB ONNX model once)
```

### Docker (PostgreSQL)
`docker compose up --build` starts PostgreSQL, the backend (migrations + seed on start) and the frontend.
**Not run on the development machine** (the Docker daemon was unavailable), so treat it as untested.

---

## Environment variables (`backend/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `APP_ENV` | `demo` | `production` disables fault injection and demo reset |
| `DATABASE_URL` | `sqlite:///./data/agentops.db` | Relative SQLite paths resolve against `backend/`. Postgres: `postgresql+psycopg://…` |
| `DEMO_ACCOUNTS_ENABLED` | `true` in example | Seeded accounts + one-click role switching. Never enable in production |
| `DEMO_PASSWORD` | `demo-pass-2026` | Password for seeded accounts |
| `COOKIE_SECURE` / `SESSION_TTL_HOURS` | `false` / `12` | Session cookie settings |
| `CORS_ORIGINS` | `http://localhost:3000` | Only needed if the UI is not served via the Next.js proxy |
| `WORKER_ENABLED` | `true` | Background worker that advances workflows |
| `ANTHROPIC_API_KEY` | empty | Enables live mode. Read on the server only |
| `LLM_CLASSIFIER_MODEL` / `LLM_PLANNER_MODEL` | `claude-haiku-5-5` / `claude-opus-5-5` | Model routing |
| `LLM_REFUSAL_FALLBACK` / `LLM_TIMEOUT_SECONDS` | `true` / `60` | Provider options |
| `RETRIEVAL_BACKEND` | `keyword` | `keyword` (TF-IDF) or `chroma` (vector search) |
| `MAX_UPLOAD_BYTES` | `5242880` | KB upload size limit |

Frontend: `BACKEND_URL` (default `http://127.0.0.1:8000`) — where Next.js proxies `/api/*`. Server-side only.

---

## What is real, sandboxed, simulated, and not implemented

| Area | Status |
|---|---|
| Persistence (tickets, workflows, steps, events, approvals, audit, KB, evaluation) | **Real** — SQLAlchemy + Alembic, SQLite by default |
| Auth, sessions, RBAC, ownership checks, CSRF header, rate limits | **Real**, server-enforced |
| Workflow engine, checkpoints, durable job queue, restart recovery, retries, idempotency | **Real** |
| SSE live updates with Last-Event-ID resume | **Real** |
| Policy engine and approval binding (parameter hash, atomic decisions) | **Real** |
| Ticket creation/updates | **Real** application persistence (built-in ticketing; no Jira) |
| Knowledge ingestion (MD/TXT/text PDF), chunking, versioned replace, injection flagging | **Real** |
| Keyword retrieval (TF-IDF) | **Real**, deterministic; labelled “not vector search” |
| Vector retrieval (ChromaDB + local MiniLM embeddings) | **Real**, optional (`RETRIEVAL_BACKEND=chroma`), tested |
| MCP server + MCP client invocation of read-only tools | **Real** (MCP Python SDK 2.3, stdio); enable via Settings → Demo controls |
| Device / account / printer diagnostics and remediations | **Sandboxed** — simulated records in the DB; no real device is touched |
| Demo-mode classifier, planner and diagnosis | **Simulated AI** — deterministic rules, labelled in the UI |
| Live LLM classification/planning/diagnosis | **Implemented, not executed** here (no key); tested with a mocked model |
| Fault injection (ticketing outage, ineffective fix) | **Simulated** failures for demonstration |
| Jira, Slack/Teams, email, monitoring connectors | **Not implemented** — shown as “Not configured” |
| OCR for scanned PDFs | **Not implemented** — documents marked “OCR required” |
| LangGraph | **Not used** — see Architecture for the substitution rationale |
| PostgreSQL / Docker Compose | Provided, **not executed** |
| Cryptographic audit tamper-proofing | **Not implemented** (append-only at the application level only) |

---

## Tests

```bash
cd backend && .venv\Scripts\python -m pytest            # 42 tests (incl. MCP subprocess + ChromaDB)
cd frontend && npx playwright install chromium && npx playwright test   # 7 E2E tests (desktop + mobile)
cd frontend && npx tsc --noEmit && npx eslint src && npm run build
```

Results from the final run on the development machine (Windows 11, Python 3.13.7, Node 22.17.1):
backend **42 passed**; Playwright **7 passed**; typecheck, lint and production build clean.
See [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) for how each acceptance criterion is verified.

Client-bundle check: `grep -rE "sk-ant|ANTHROPIC_API_KEY|demo-pass" frontend/.next/static` matches only the
UI help text that *names* the `ANTHROPIC_API_KEY` variable; no key or password value is present.

## Documentation
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layers, state machine, data model, API, security
- [docs/SCENARIOS.md](docs/SCENARIOS.md) — scenarios A–H: expected tool calls, approvals, final status, verification
- [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) — five-minute viva walkthrough
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) — acceptance criteria → tests
- [docs/DEPLOY.md](docs/DEPLOY.md) — one-container deployment to Render (free tier) or any Docker host

## Team
Khushwant Rajpurohit (Team Lead, agent reasoning & planning) · Nirmal Rajpurohit (knowledge base & RAG) ·
Piyush Prajapat (tool integration & backend) · Keshav Thathera (human-in-the-loop, frontend & QA)
