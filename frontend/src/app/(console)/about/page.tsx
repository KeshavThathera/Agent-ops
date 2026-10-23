import { ArrowDown, BookOpen, Bot, Building2, Database, Eye, GraduationCap, Layers, MessagesSquare, ShieldCheck, Users, Wrench } from "lucide-react";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";

export const metadata = { title: "About Project" };

const LAYERS = [
  { n: 1, icon: MessagesSquare, name: "Interaction layer", body: "Next.js operations console: support workspace (chat is one interface), tickets, approval queue, execution trace, knowledge base, evaluation and audit views." },
  { n: 2, icon: Layers, name: "Orchestration layer", body: "Persisted state machine in FastAPI. Each node or plan step commits a checkpoint; a durable job queue resumes work after restarts. Live progress over Server-Sent Events." },
  { n: 3, icon: Bot, name: "Reasoning layer", body: "Classification, missing-information detection, diagnostic planning and diagnosis. Deterministic in demo mode; Claude with schema-validated output and one repair attempt in live mode." },
  { n: 4, icon: BookOpen, name: "Knowledge layer (RAG)", body: "Document ingestion, heading-aware chunking with source and version metadata, keyword (TF-IDF) or ChromaDB vector retrieval, relevance thresholds and prompt-injection flagging." },
  { n: 5, icon: Wrench, name: "Tool & integration layer", body: "Typed tool registry with strict input schemas, sandboxed IT diagnostics and remediations, real ticketing persistence, and an MCP server exposing read-only tools over stdio." },
  { n: 6, icon: ShieldCheck, name: "Governance & observability layer", body: "Deterministic risk policy, RBAC and ownership checks, approvals bound to parameter hashes, verification before resolution, append-only audit trail and a repeatable evaluation harness." },
];

const FLOW = [
  "Employee: “My laptop cannot connect to the office VPN.” Request persisted; idempotency key prevents duplicates.",
  "Classified as VPN, medium priority. Sandbox laptop primed with the VPN fixture. Ticket created through the create_ticket tool.",
  "Knowledge base searched; the VPN troubleshooting guide is retrieved with chunk-level citations.",
  "Diagnostic plan: read device status → run VPN diagnostics → check VPN gateway service.",
  "Diagnosis from observed results: authentication fails with an expired session; gateway operational. The verifier confirms the conclusion is supported.",
  "Targeted retrieval for the fix; recommendation cites the “Fix: expired VPN session token” section.",
  "Refreshing the session changes configuration → POL-DEVICE-CHANGE → workflow pauses for an engineer’s approval.",
  "Engineer approves the exact parameter version; the workflow resumes from its checkpoint and executes once.",
  "verify_resolution re-runs diagnostics: tunnel up, intranet reachable → ticket resolved with verification evidence.",
];

const STACK = [
  ["Frontend", "Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, Lucide icons, Recharts"],
  ["Backend", "Python 3.13, FastAPI, Pydantic 2, SQLAlchemy 2, Alembic migrations"],
  ["Workflow engine", "Custom persisted state machine + database job queue (substitution for LangGraph — see limitations)"],
  ["Database", "SQLite by default; PostgreSQL via DATABASE_URL and Docker Compose"],
  ["Retrieval", "Deterministic TF-IDF keyword retrieval (default) or ChromaDB with local all-MiniLM-L6-v2 embeddings"],
  ["LLM (live mode)", "Anthropic Claude via the official SDK; lightweight classifier and stronger planner configurable by environment"],
  ["Tool protocol", "Model Context Protocol Python SDK 2.x: MCP server over stdio + MCP client invocation path"],
  ["Testing", "pytest backend acceptance tests; Playwright end-to-end UI tests"],
];

const TEAM = [
  ["Khushwant Rajpurohit", "Team Lead", "Agent reasoning & planning"],
  ["Keshav Thathera", "Co-Lead", "Human-in-the-loop, frontend & QA"],
  ["Nirmal Rajpurohit", "Member", "Knowledge base & RAG pipeline"],
  ["Piyush Prajapat", "Member", "Tool integration & backend"],
];

export default function AboutPage() {
  return (
    <>
      <PageHeader title="About the project" description="Academic context and an accurate description of what this prototype implements." />
      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap items-start gap-4 px-5 py-5">
            <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-navy-900 text-white"><GraduationCap className="size-6" aria-hidden /></span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Final-year engineering project · 2026–27</p>
              <h2 className="mt-1 text-lg font-semibold leading-snug">Agentic AI Workflow Automation for Intelligent Business Process Management</h2>
              <p className="mt-0.5 text-[13.5px] text-ink-2">Report title: Agentic AI Workflow Automation System · Product: <span className="font-medium">AgentOps Desk</span> — Agentic AI IT Operations & Support Platform</p>
              <p className="mt-2 flex items-center gap-1.5 text-[13px] text-muted"><Building2 className="size-4" aria-hidden />Engineering College Bikaner, Bikaner Technical University</p>
            </div>
          </div>
          <div className="border-t border-line px-5 py-4 text-[13.5px] leading-relaxed text-ink-2">
            <p className="font-medium text-ink">Project statement</p>
            <p className="mt-1">The project focuses on autonomous workflow execution using LLM-based agents, tool calling, structured state, retrieval, verification, and human-in-the-loop controls.</p>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Problem statement" />
            <div className="space-y-2 px-5 py-4 text-[13.5px] leading-relaxed text-ink-2">
              <p>IT support teams spend much of their time on repetitive tickets: VPN failures, Wi-Fi problems, lockouts, mail sync and printer faults. Chatbots that only retrieve articles can suggest fixes but cannot diagnose, act or confirm results, and fully autonomous agents are risky when they change configuration without oversight.</p>
              <p>This project demonstrates a middle path: an agentic workflow that plans, calls tools, keeps structured state, grounds recommendations in evidence, pauses for human approval when policy requires it, and resolves tickets only after verification.</p>
            </div>
          </Card>
          <Card>
            <CardHeader title="Objectives" />
            <ul className="list-disc space-y-1.5 py-4 pl-9 pr-5 text-[13.5px] text-ink-2">
              <li>Execute an end-to-end IT support workflow from request to verified resolution.</li>
              <li>Ground every recommendation in cited knowledge-base evidence and refuse to invent guidance.</li>
              <li>Enforce risk policy, RBAC and approvals outside the LLM, at execution time.</li>
              <li>Persist workflow state so work survives refreshes, restarts and transient failures without duplicate side effects.</li>
              <li>Make every decision observable and auditable, and measure behaviour against a retrieval-only baseline.</li>
            </ul>
          </Card>
        </div>

        <Card>
          <CardHeader title="Six-layer architecture" subtitle="As implemented in this prototype" />
          <ol className="space-y-2 px-5 py-4">
            {LAYERS.map((l, i) => (
              <li key={l.n}>
                <div className="flex gap-3 rounded-lg border border-line bg-white px-4 py-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-700"><l.icon className="size-4" aria-hidden /></span>
                  <div>
                    <p className="text-[13.5px] font-semibold">{l.n}. {l.name}</p>
                    <p className="mt-0.5 text-[13px] text-ink-2">{l.body}</p>
                  </div>
                </div>
                {i < LAYERS.length - 1 && <ArrowDown className="mx-auto my-1 size-4 text-slate-300" aria-hidden />}
              </li>
            ))}
          </ol>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Workflow example" subtitle="Scenario A, exactly as the engine runs it" />
            <ol className="list-decimal space-y-1.5 py-4 pl-9 pr-5 text-[13px] leading-relaxed text-ink-2">{FLOW.map((f) => <li key={f}>{f}</li>)}</ol>
          </Card>
          <Card>
            <CardHeader title="Technology stack" icon={<Database className="size-4" aria-hidden />} />
            <dl className="divide-y divide-line">
              {STACK.map(([k, v]) => (
                <div key={k} className="grid grid-cols-[8.5rem_1fr] gap-3 px-5 py-2 text-[13px]"><dt className="font-medium">{k}</dt><dd className="text-ink-2">{v}</dd></div>
              ))}
            </dl>
          </Card>
        </div>

        <Card>
          <CardHeader title="Team responsibilities" icon={<Users className="size-4" aria-hidden />} />
          <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
            {TEAM.map(([n, r, a]) => (
              <div key={n} className="rounded-lg border border-line p-3">
                <p className="text-[13.5px] font-semibold">{n}</p>
                <p className="text-xs text-muted">{r}</p>
                <p className="mt-1.5 text-[13px] text-ink-2">{a}</p>
              </div>
            ))}
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Scope and limitations" icon={<Eye className="size-4" aria-hidden />} />
            <ul className="list-disc space-y-1.5 py-4 pl-9 pr-5 text-[13px] leading-relaxed text-ink-2">
              <li>All IT diagnostics and remediations run against simulated sandbox records. The application never inspects or changes a real device, including the visitor’s computer.</li>
              <li>Ticketing uses the application’s own database. Jira, Slack/Teams, email and monitoring connectors are not implemented and are shown as “Not configured”.</li>
              <li>Demo mode uses a deterministic classifier and planner. Live mode needs a server-side Anthropic API key.</li>
              <li>Workflow orchestration is a custom persisted state machine rather than LangGraph, so that approvals, idempotency keys and recovery live in the same database transaction as application data.</li>
              <li>The audit log is append-only in the application but not cryptographically tamper-proof. OCR for scanned PDFs is not configured.</li>
              <li>Evaluation results in demo mode measure the deterministic pipeline on its own designed cases; they are not research findings.</li>
            </ul>
          </Card>
          <Card>
            <CardHeader title="Future extensions" />
            <div className="space-y-3 px-5 py-4 text-[13px] text-ink-2">
              <p>The same governed workflow pattern can be applied to other business processes. These are future work and are not implemented here:</p>
              <div className="flex flex-wrap gap-2">
                {["Healthcare (appointment & records workflows)", "Insurance (claims triage)", "Legal services (document intake)", "HR (onboarding & access requests)"].map((x) => <Badge key={x} tone="slate">{x}</Badge>)}
              </div>
              <p>Other next steps: real ITSM connectors, OCR for scanned documents, SSO, per-tenant policy, and evaluation on a larger, independently written dataset.</p>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
