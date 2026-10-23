# Five-minute viva demonstration

**Before the viva:** `python -m app.cli reset` (fresh seed), start backend and frontend, open two browser windows
(or one normal + one private window): **Window 1** signed in as *Riya Mehta (employee)*, **Window 2** as
*Sana Khan (engineer)*. Keep *Neha Joshi (admin)* for the last minute.

### 0:00 – 0:30 · Framing
“AgentOps Desk is an agentic workflow platform demonstrated on IT support. The agent plans, calls tools, keeps
structured state and grounds its fixes in retrieved evidence, but policy, approvals and verification are enforced
by deterministic server code. The badge at the top says it plainly: demo mode, simulated AI and sandboxed IT tools —
nothing touches a real laptop.”

### 0:30 – 2:00 · Scenario A, end to end (Window 1 → Window 2)
1. Window 1: **Support Workspace** → example **Cannot connect to VPN** → *Submit request*.
2. Point at the live conversation: ticket TKT-xxxx created, recommendation with **citation chips** → click one: the
   KB article opens at the highlighted, cited chunk.
3. “It paused: refreshing the VPN session changes configuration, so POL-DEVICE-CHANGE needs an engineer.”
4. Window 2: **Approvals** → the card shows the exact action, target `SBX-LT-…` (sandbox), validated parameters,
   policy, diagnosis + verifier result, evidence, and the parameter hash. *Approve* with a reason.
5. Open **Full trace** (Workflow Execution): stage stepper, plan revision 1 (diagnostics) and revision 2 (derived
   from observed results), tool calls with durations, timeline events streamed over SSE, **Verification: Verified**,
   ticket resolved. “Resolution happened only because the diagnostic re-check passed.”

### 2:00 – 3:00 · Safety behaviours (Window 2, Support Workspace → Viva scenarios)
- **G · Unsafe request** → blocked, policy explained, no tools ran (timeline shows `policy_denied`).
- **H · Malicious KB document** → evidence panel shows the community-wiki chunk flagged *Untrusted instructions*;
  the approval is still required. “Document text cannot change policy.”
- Mention the approval binding: approve twice → the second click gets *already approved*; editing parameters
  creates v2 and invalidates v1.

### 3:00 – 4:00 · Reliability and human control
- **F · Ticketing API transient failure** → timeline shows two `retry_scheduled` events; tool calls show
  error, error, success with `reconciled: true`; Tickets list shows **one** ticket.
- **D · Printer hardware fault** → routed to human review; *Take over* → *Escalate* to on-site hardware support.
- **E · Ambiguous complaint** (Window 1) → targeted question; click *The VPN on my laptop* → the same workflow id resumes.

### 4:00 – 5:00 · Governance (sign in as Neha Joshi)
- **Dashboard**: switch *Seeded demo data / Live runs* — every tile is computed from stored records.
- **Evaluation** → *Run evaluation*: baseline vs agent on 13 cases with numerators/denominators, N/A where a metric
  doesn't apply, CSV/JSON export. “These demo-mode numbers validate behaviour on our own designed cases; they are not
  research findings.”
- **Audit log** filtered to *Approval decisions* / *Requests (incl. blocked)*.
- **Tools & Integrations** → *Test connection* on the MCP server (negotiated protocol version + tool list);
  external connectors honestly show *Not configured*.

**Likely questions:** Why not LangGraph? (see ARCHITECTURE “Substitutions”). What does the LLM decide in live mode?
(classification, diagnostic plan, diagnosis — each schema-validated and verifier-checked; never approvals or policy).
What if the LLM API fails? (workflow fails visibly; the user can explicitly start a separate demo run).
