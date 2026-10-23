"use client";

import Link from "next/link";
import { Fragment, useState, type ReactNode } from "react";
import {
  ArrowRight, BadgeCheck, Ban, BookOpen, Bot, CheckCheck, ChevronDown, ChevronRight, CircleCheck, FlaskConical, Hand, Inbox, Lightbulb,
  ListChecks, RefreshCw, RotateCcw, Send, ShieldAlert, ShieldX, Stethoscope, Tags, Ticket as TicketIcon, UserCheck, UserRoundCog,
  Wrench, XCircle, Zap, Radio, WifiOff, Circle,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import {
  fmtDate, fmtMs, fmtTime, label, PRIORITY_TONE, STEP_STATUS, TICKET_STATUS, TOOL_STATUS, WORKFLOW_STATUS,
} from "@/lib/format";
import type { StreamState } from "@/lib/hooks";
import type { Evidence, Message, Step, ToolCall, WorkflowDetail, WorkflowEvent } from "@/lib/types";
import { Badge, Button, Card, CardHeader, CopyButton, cx, Dialog, EmptyState, Field, Json, Notice, Select, SimulatedTag, StatusBadge, Textarea, useToast } from "./ui";

// ================================================================== stage stepper
const MAIN = ["received", "classifying", "retrieving", "planning", "diagnosing", "awaiting_approval", "executing", "verifying", "completed"];
const BRANCH = ["awaiting_user_input", "awaiting_human_review", "escalated", "failed", "cancelled", "blocked"];

export function StageStepper({ d }: { d: WorkflowDetail }) {
  const reached = new Set<string>(["received"]);
  for (const e of d.events) if (e.type === "stage_changed" && typeof e.data.to === "string") reached.add(e.data.to);
  const status = d.workflow.status;
  const lastIdx = Math.max(...MAIN.map((s, i) => (reached.has(s) ? i : -1)));
  const branch = BRANCH.includes(status) ? status : null;
  return (
    <div>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 py-1" aria-label="Workflow stages">
        {MAIN.map((s, i) => {
          const isCurrent = s === status;
          const done = reached.has(s) && !isCurrent;
          const skipped = !reached.has(s) && i < lastIdx;
          const meta = WORKFLOW_STATUS[s];
          return (
            <Fragment key={s}>
              {i > 0 && <li aria-hidden className={cx("h-px w-4 sm:w-6", done || isCurrent ? "bg-indigo-300" : "bg-line")} />}
              <li
                aria-current={isCurrent ? "step" : undefined}
                className={cx(
                  "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
                  isCurrent && (meta.tone === "green" ? "bg-emerald-50 text-emerald-800 ring-emerald-300" : meta.tone === "amber" ? "bg-amber-50 text-amber-900 ring-amber-300" : "bg-indigo-600 text-white ring-indigo-600"),
                  done && "bg-white text-ink-2 ring-line",
                  skipped && "bg-transparent text-slate-400 ring-dashed ring-slate-200 line-through decoration-slate-300",
                  !isCurrent && !done && !skipped && "bg-transparent text-slate-400 ring-slate-200",
                )}
              >
                {done ? <CircleCheck className="size-3.5 text-emerald-600" aria-hidden /> : isCurrent ? <Circle className="size-2.5 fill-current" aria-hidden /> : <Circle className="size-2.5" aria-hidden />}
                {meta.label}
                <span className="sr-only">{done ? "(done)" : isCurrent ? "(current)" : skipped ? "(not needed)" : "(upcoming)"}</span>
              </li>
            </Fragment>
          );
        })}
        {branch && (
          <>
            <li aria-hidden className="h-px w-6 bg-amber-300" />
            <li aria-current="step"><StatusBadge meta={WORKFLOW_STATUS} value={branch} /></li>
          </>
        )}
      </ol>
    </div>
  );
}

// ================================================================== header + actions
export function StreamIndicator({ state, terminal }: { state: StreamState; terminal: boolean }) {
  if (terminal) return <span className="inline-flex items-center gap-1 text-xs text-muted"><Radio className="size-3.5" aria-hidden />Finished</span>;
  const map = {
    live: { t: "Live updates", c: "text-emerald-700", I: Radio },
    connecting: { t: "Connecting…", c: "text-muted", I: Radio },
    reconnecting: { t: "Reconnecting…", c: "text-amber-700", I: WifiOff },
    closed: { t: "Updates paused", c: "text-red-700", I: WifiOff },
  }[state];
  return <span className={cx("inline-flex items-center gap-1 text-xs", map.c)} aria-live="polite"><map.I className="size-3.5" aria-hidden />{map.t}</span>;
}

export function WorkflowHeader({ d, stream, onChanged, staffView }: { d: WorkflowDetail; stream: StreamState; onChanged: () => void; staffView: boolean }) {
  const w = d.workflow;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-4 sm:px-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge meta={WORKFLOW_STATUS} value={w.status} />
            <Badge tone={w.mode === "live" ? "indigo" : "amber"}>{w.mode === "live" ? "Live LLM run" : "Demo run · deterministic planner"}</Badge>
            {w.origin !== "live" && <Badge tone="slate">{w.origin === "seed" ? "Seeded demo data" : "Evaluation run"}</Badge>}
            {w.automation_paused && <Badge tone="amber" icon={<UserRoundCog className="size-3.5" aria-hidden />}>Taken over by {d.taken_over_by?.name ?? "engineer"}</Badge>}
            <StreamIndicator state={stream} terminal={d.terminal} />
          </div>
          <p className="mt-2 text-[15px] font-medium leading-snug text-ink">“{w.original_request}”</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted">
            <span className="flex items-center gap-1">Workflow <span className="font-mono text-ink-2">{w.id}</span><CopyButton value={w.id} label="Copy workflow ID" /></span>
            {d.ticket && (
              <Link href={`/tickets/${d.ticket.id}`} className="flex items-center gap-1 font-medium text-indigo-700 hover:underline">
                <TicketIcon className="size-3.5" aria-hidden />{d.ticket.display_id}
              </Link>
            )}
            {d.ticket && <span className="flex items-center gap-1">Ticket status <StatusBadge meta={TICKET_STATUS} value={d.ticket.status} /></span>}
            <span>Requester {w.requester_name}</span>
            <span>Created {fmtDate(w.created_at)}</span>
          </div>
        </div>
        <WorkflowActions d={d} onChanged={onChanged} />
      </div>
      <div className="grid grid-cols-2 gap-px border-t border-line bg-line text-[12.5px] sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Category", <span key="c" className="flex items-center gap-1.5">{label(w.category)}{w.priority && <Badge tone={PRIORITY_TONE[w.priority]}>{w.priority}</Badge>}</span>],
          ["Checkpoint", `v${w.version}`],
          ["Retries", String(w.retry_count)],
          ["Automated time", fmtMs(w.active_ms)],
          ["Tokens", w.mode === "demo" ? "0 (no model calls)" : `${w.input_tokens.toLocaleString()} in · ${w.output_tokens.toLocaleString()} out`],
          ["Est. model cost", w.mode === "demo" ? "$0.00" : `$${w.cost_usd.toFixed(4)}`],
        ].map(([k, v]) => (
          <div key={String(k)} className="bg-white px-4 py-2.5">
            <p className="text-muted">{k}</p>
            <div className="mt-0.5 font-medium text-ink">{v}</div>
          </div>
        ))}
      </div>
      {staffView && d.state.faults && (d.state.faults.ticketing !== "none" || d.state.faults.verification !== "none") && (
        <div className="border-t border-line px-4 py-2 text-xs text-amber-800 sm:px-5">
          Fault injection active for this run: ticketing = {d.state.faults.ticketing}, verification = {d.state.faults.verification}
        </div>
      )}
    </Card>
  );
}

const GROUPS = [
  ["service_desk", "Service desk"], ["network_team", "Network team"], ["identity_team", "Identity team"],
  ["collaboration_team", "Collaboration team"], ["hardware_onsite", "On-site hardware support"], ["security", "Security team"],
];

export function WorkflowActions({ d, onChanged }: { d: WorkflowDetail; onChanged: () => void }) {
  const toast = useToast();
  const [dialog, setDialog] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [group, setGroup] = useState("service_desk");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const acts = d.available_actions;

  const run = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    setError(null);
    try {
      await api.post(`/workflows/${d.workflow.id}/actions`, { action, ...extra });
      setDialog(null);
      toast("success", `${label(action)} recorded`);
      onChanged();
    } catch (e) {
      setError((e as ApiError).message);
      if (!dialog) toast("error", (e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };
  const openDialog = (name: string) => { setReason(""); setNote(""); setError(null); setDialog(name); };

  if (!acts.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {acts.includes("takeover") && <Button size="sm" icon={<UserRoundCog className="size-4" aria-hidden />} loading={busy === "takeover"} onClick={() => run("takeover")}>Take over</Button>}
      {acts.includes("release") && <Button size="sm" loading={busy === "release"} onClick={() => run("release")}>Hand back to automation</Button>}
      {acts.includes("retry") && <Button size="sm" variant="primary" icon={<RotateCcw className="size-4" aria-hidden />} loading={busy === "retry"} onClick={() => run("retry")}>Retry safely</Button>}
      {acts.includes("request_info") && <Button size="sm" onClick={() => openDialog("request_info")}>Request info</Button>}
      {acts.includes("resolve") && <Button size="sm" variant="success" onClick={() => openDialog("resolve")}>Resolve</Button>}
      {acts.includes("escalate") && <Button size="sm" variant="warning" onClick={() => openDialog("escalate")}>Escalate</Button>}
      {acts.includes("cancel") && <Button size="sm" variant="ghost" icon={<Ban className="size-4" aria-hidden />} onClick={() => openDialog("cancel")}>Cancel</Button>}

      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={{ resolve: "Resolve with verification", escalate: "Escalate ticket", request_info: "Ask the requester", cancel: "Cancel workflow" }[dialog ?? ""] ?? ""}
        description={dialog === "resolve" ? "Manual resolution must record how the fix was verified." : dialog === "cancel" ? "Stops automation before any further side effects. Pending approvals are cancelled." : undefined}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Close</Button>
            <Button
              variant={dialog === "cancel" ? "danger" : "primary"}
              loading={!!busy}
              disabled={(dialog === "resolve" && (reason.trim().length < 3 || note.trim().length < 3)) || ((dialog === "escalate" || dialog === "request_info") && reason.trim().length < 3)}
              onClick={() => run(dialog!, dialog === "request_info" ? { message: reason } : { reason, verification_note: note || undefined, group: dialog === "escalate" ? group : undefined })}
            >
              {dialog === "cancel" ? "Cancel workflow" : "Confirm"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <Notice tone="red" title="Not applied">{error}</Notice>}
          {dialog === "escalate" && (
            <Field label="Escalate to" htmlFor="esc-group">
              <Select id="esc-group" value={group} onChange={(e) => setGroup(e.target.value)}>
                {GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </Field>
          )}
          <Field label={dialog === "request_info" ? "Question" : "Reason"} htmlFor="act-reason" required={dialog !== "cancel"}>
            <Textarea id="act-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
          </Field>
          {dialog === "resolve" && (
            <Field label="Verification evidence" htmlFor="act-note" required hint="For example: “Technician printed a test page on site”.">
              <Textarea id="act-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
            </Field>
          )}
        </div>
      </Dialog>
    </div>
  );
}

// ================================================================== decision summary
export function DecisionPanel({ d }: { d: WorkflowDetail }) {
  const c = d.state.classification;
  const dx = d.state.diagnosis;
  const rec = [...d.events].reverse().find((e) => e.type === "recommendation");
  return (
    <Card>
      <CardHeader title="Decision summary" subtitle="Concise, observable decisions. Model reasoning is not requested, stored or shown." icon={<Lightbulb className="size-4" aria-hidden />} />
      <div className="space-y-4 px-4 py-3.5 text-[13px]">
        {!c ? <p className="text-muted">Not classified yet.</p> : (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Classification</p>
            <p className="mt-1">
              <span className="font-medium">{label(c.category)}</span> · {c.priority} priority · <span className="text-muted">{c.method}{c.model ? ` (${c.model})` : ""}</span>
            </p>
            {c.missing_information?.length > 0 && <p className="mt-1 text-amber-800">Missing: {c.missing_information.join(", ")}</p>}
            {c.unsafe?.length > 0 && (
              <ul className="mt-1.5 space-y-1">{c.unsafe.map((u) => <li key={u.action_class} className="flex gap-1.5 text-red-700"><ShieldX className="mt-0.5 size-3.5 shrink-0" aria-hidden />{u.reason}</li>)}</ul>
            )}
          </div>
        )}
        {dx && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Diagnosis</p>
            <p className="mt-1 text-ink-2">{dx.finding}</p>
            <p className={cx("mt-1.5 flex items-start gap-1.5 text-xs", dx.verifier.supported ? "text-emerald-700" : "text-red-700")}>
              {dx.verifier.supported ? <BadgeCheck className="size-3.5 shrink-0" aria-hidden /> : <XCircle className="size-3.5 shrink-0" aria-hidden />}
              Verifier: {dx.verifier.detail}
            </p>
            {dx.action && <p className="mt-1 text-xs text-muted">Selected remediation: <span className="font-mono">{dx.action}</span> ({dx.method})</p>}
          </div>
        )}
        {rec && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Recommendation</p>
            <p className="mt-1 text-ink-2">{rec.summary}</p>
          </div>
        )}
        {d.state.review && ["awaiting_human_review", "escalated"].includes(d.workflow.status) && (
          <Notice tone="amber" title="Routed to human review" icon={<UserRoundCog className="size-4" aria-hidden />}>
            {d.state.review.reason} · group: {label(d.state.review.group)}
          </Notice>
        )}
        {d.state.escalation && <Notice tone="violet" title={`Escalated to ${label(d.state.escalation.group)}`}>{d.state.escalation.reason}</Notice>}
      </div>
    </Card>
  );
}

export function VerificationCard({ d }: { d: WorkflowDetail }) {
  const v = d.verification;
  if (!v || v.verified === undefined) {
    return (
      <Card>
        <CardHeader title="Verification" icon={<CheckCheck className="size-4" aria-hidden />} />
        <p className="px-4 py-3.5 text-[13px] text-muted">No verification yet. The ticket is only resolved after a diagnostic check or confirmation passes.</p>
      </Card>
    );
  }
  return (
    <Card className={cx(v.verified ? "ring-1 ring-emerald-200" : "ring-1 ring-red-200")}>
      <CardHeader
        title="Verification"
        icon={<CheckCheck className="size-4" aria-hidden />}
        actions={v.verified ? <Badge tone="green" icon={<BadgeCheck className="size-3.5" aria-hidden />}>Verified</Badge> : <Badge tone="red" icon={<XCircle className="size-3.5" aria-hidden />}>Not verified</Badge>}
      />
      <div className="space-y-2 px-4 py-3.5 text-[13px]">
        <p>Method: <span className="font-medium">{label(v.method)}</span>{v.check && <> · check <span className="font-mono text-[12px]">{v.check}</span></>}{v.method === "diagnostic" && <> <SimulatedTag label="Sandbox" /></>}</p>
        {v.observations && (
          <ul className="space-y-0.5 font-mono text-[12px] text-ink-2">
            {Object.entries(v.observations).map(([k, val]) => <li key={k}>{k}: {String(val)}</li>)}
          </ul>
        )}
        {v.user_confirmed && <p className="text-emerald-700">Requester confirmed the fix.</p>}
        {v.note && <p>Technician note: {v.note}</p>}
        {v.verified_at && <p className="text-xs text-muted">{fmtDate(v.verified_at)}</p>}
      </div>
    </Card>
  );
}

// ================================================================== plan
export function PlanSteps({ d }: { d: WorkflowDetail }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!d.steps.length) {
    return (
      <Card>
        <CardHeader title="Structured plan" icon={<ListChecks className="size-4" aria-hidden />} />
        <EmptyState title="No plan yet" body={d.workflow.status === "blocked" ? "The request was blocked before planning." : "The plan appears after classification and retrieval."} />
      </Card>
    );
  }
  const revisions = [
    { title: "Revision 1 · diagnostics", steps: d.steps.filter((s) => s.step_key.startsWith("s")) },
    { title: "Revision 2 · from observed results", steps: d.steps.filter((s) => s.step_key.startsWith("p")) },
  ].filter((r) => r.steps.length);
  return (
    <Card>
      <CardHeader title="Structured plan" subtitle={d.plan_summary ?? undefined} icon={<ListChecks className="size-4" aria-hidden />} />
      <div className="divide-y divide-line">
        {revisions.map((r) => (
          <div key={r.title}>
            <p className="bg-slate-50/70 px-4 py-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted">{r.title}</p>
            <ol className="divide-y divide-line">
              {r.steps.map((s) => <StepRow key={s.id} s={s} d={d} open={open === s.id} toggle={() => setOpen(open === s.id ? null : s.id)} />)}
            </ol>
          </div>
        ))}
      </div>
    </Card>
  );
}

function StepRow({ s, d, open, toggle }: { s: Step; d: WorkflowDetail; open: boolean; toggle: () => void }) {
  const calls = d.tool_calls.filter((c) => c.step_id === s.id);
  const dur = s.started_at && s.finished_at ? new Date(s.finished_at).getTime() - new Date(s.started_at).getTime() : null;
  return (
    <li className="px-4 py-2.5">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-start gap-3 text-left">
        <span className="mt-0.5 w-7 shrink-0 font-mono text-[11.5px] text-muted">{s.step_key}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-medium text-ink">{s.title}</span>
            <StatusBadge meta={STEP_STATUS} value={s.status} live={!d.terminal} />
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
            <span className="font-mono text-ink-2">{s.tool}</span>
            {s.depends_on.length > 0 && <span>after {s.depends_on.join(", ")}</span>}
            {s.attempts > 1 && <span className="text-amber-700">{s.attempts} attempts</span>}
            {dur !== null && <span>{fmtMs(dur)}</span>}
          </span>
          {s.result_summary && <span className="mt-1 block text-[12.5px] text-ink-2">{s.result_summary}</span>}
        </span>
        {open ? <ChevronDown className="mt-0.5 size-4 text-muted" aria-hidden /> : <ChevronRight className="mt-0.5 size-4 text-muted" aria-hidden />}
      </button>
      {open && (
        <div className="mt-2 space-y-2 pl-10">
          {s.rationale && <p className="text-xs text-muted">Purpose: {s.rationale}</p>}
          <p className="text-xs font-medium text-ink-2">Validated arguments (sanitised)</p>
          <Json value={s.arguments} />
          {calls.length > 0 && <p className="text-xs text-muted">{calls.length} tool call{calls.length > 1 ? "s" : ""} recorded for this step (see Tool calls).</p>}
        </div>
      )}
    </li>
  );
}

// ================================================================== timeline
const EVENT_ICON: Record<string, { I: typeof Bot; c: string }> = {
  request_received: { I: Inbox, c: "text-slate-500" },
  stage_changed: { I: ArrowRight, c: "text-indigo-500" },
  classified: { I: Tags, c: "text-indigo-600" },
  sandbox_primed: { I: FlaskConical, c: "text-amber-600" },
  tool_call: { I: Wrench, c: "text-slate-600" },
  ticket_linked: { I: TicketIcon, c: "text-sky-600" },
  evidence_retrieved: { I: BookOpen, c: "text-indigo-600" },
  untrusted_content: { I: ShieldAlert, c: "text-red-600" },
  insufficient_evidence: { I: ShieldAlert, c: "text-amber-600" },
  plan_created: { I: ListChecks, c: "text-indigo-600" },
  plan_revised: { I: ListChecks, c: "text-indigo-600" },
  diagnosis: { I: Stethoscope, c: "text-indigo-600" },
  verifier_check: { I: BadgeCheck, c: "text-emerald-600" },
  recommendation: { I: Lightbulb, c: "text-amber-600" },
  approval_requested: { I: Hand, c: "text-amber-600" },
  approval_decided: { I: UserCheck, c: "text-emerald-600" },
  approval_invalidated: { I: RotateCcw, c: "text-amber-600" },
  remediation_executed: { I: Zap, c: "text-emerald-600" },
  verification: { I: CheckCheck, c: "text-emerald-600" },
  retry_scheduled: { I: RefreshCw, c: "text-amber-600" },
  policy_denied: { I: ShieldX, c: "text-red-600" },
  step_skipped: { I: Ban, c: "text-slate-500" },
};

export function Timeline({ events }: { events: WorkflowEvent[] }) {
  const [hideStages, setHideStages] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const shown = hideStages ? events.filter((e) => e.type !== "stage_changed") : events;
  return (
    <Card>
      <CardHeader
        title="Execution timeline"
        subtitle={`${events.length} persisted events · each comes from the workflow engine, not a progress animation`}
        icon={<Radio className="size-4" aria-hidden />}
        actions={
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={hideStages} onChange={(e) => setHideStages(e.target.checked)} className="size-3.5 rounded border-line" />
            Hide stage changes
          </label>
        }
      />
      <ol className="relative px-4 py-3">
        {shown.map((e, i) => {
          const m = EVENT_ICON[e.type] ?? { I: Circle, c: "text-slate-400" };
          const failed = e.type === "tool_call" && (e.data.status === "error" || e.data.status === "blocked");
          const hasData = Object.keys(e.data ?? {}).length > 0;
          return (
            <li key={e.id} className="relative flex gap-3 pb-3 last:pb-0 animate-fade-in">
              {i < shown.length - 1 && <span aria-hidden className="absolute left-[11px] top-6 h-[calc(100%-12px)] w-px bg-line" />}
              <span className={cx("relative z-10 mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-white ring-1 ring-line", failed ? "text-red-600" : m.c)}>
                <m.I className="size-3.5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <p className={cx("text-[13px] leading-snug", failed ? "text-red-700" : "text-ink")}>{e.summary}</p>
                  {e.simulated && <SimulatedTag />}
                </div>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted">
                  <time dateTime={e.created_at}>{fmtTime(e.created_at)}</time>
                  <span className="font-mono">{e.type}</span>
                  {typeof e.data.transport === "string" && e.data.transport === "mcp" && <Badge tone="violet">via MCP</Badge>}
                  {typeof e.data.duration_ms === "number" && e.type === "tool_call" && <span>{fmtMs(e.data.duration_ms as number)}</span>}
                  {hasData && (
                    <button type="button" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id} className="font-medium text-indigo-700 hover:underline">
                      {open === e.id ? "Hide details" : "Details"}
                    </button>
                  )}
                </p>
                {open === e.id && <Json value={e.data} className="mt-1.5" />}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

// ================================================================== tool calls
export function ToolCallsTable({ calls }: { calls: ToolCall[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!calls.length) return <Card><EmptyState title="No tool calls yet" /></Card>;
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full text-[13px]">
          <thead className="bg-slate-50 text-left text-xs text-muted">
            <tr>
              {["Time", "Tool", "Status", "Attempt", "Duration", "Transport", "Execution", "Policy", ""].map((h) => <th key={h} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {calls.map((c) => (
              <Fragment key={c.id}>
                <tr className={cx("hover:bg-slate-50/60", c.status !== "success" && "bg-red-50/30")}>
                  <td className="whitespace-nowrap px-3 py-2 text-muted">{fmtTime(c.created_at)}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px]">{c.tool_name}</td>
                  <td className="px-3 py-2"><StatusBadge meta={TOOL_STATUS} value={c.status} /></td>
                  <td className="px-3 py-2">{c.attempt}</td>
                  <td className="whitespace-nowrap px-3 py-2">{fmtMs(c.duration_ms)}</td>
                  <td className="px-3 py-2">{c.transport === "mcp" ? <Badge tone="violet">MCP stdio</Badge> : <span className="text-muted">in-process</span>}</td>
                  <td className="px-3 py-2">{c.simulated ? <SimulatedTag label="Sandbox" /> : <span className="text-xs text-ink-2">real app logic</span>}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">{c.policy_decision ? label(c.policy_decision) : "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}
                      className="text-xs font-medium text-indigo-700 hover:underline">{open === c.id ? "Hide" : "Inspect"}</button>
                  </td>
                </tr>
                {open === c.id && (
                  <tr>
                    <td colSpan={9} className="bg-slate-50/70 px-3 py-3">
                      <div className="grid gap-3 lg:grid-cols-2">
                        <div><p className="mb-1 text-xs font-medium text-ink-2">Arguments (sanitised)</p><Json value={c.arguments} /></div>
                        <div>
                          <p className="mb-1 text-xs font-medium text-ink-2">{c.error ? `Error (${c.error_kind})` : "Result"}</p>
                          {c.error ? <Notice tone="red">{c.error}</Notice> : <Json value={c.result} />}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ================================================================== evidence
export function EvidenceList({ evidence, compact = false }: { evidence: Evidence[]; compact?: boolean }) {
  if (!evidence.length) {
    return (
      <Card>
        <CardHeader title="Retrieved evidence" icon={<BookOpen className="size-4" aria-hidden />} />
        <p className="px-4 py-3.5 text-[13px] text-muted">No evidence retrieved yet.</p>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title="Retrieved evidence" subtitle="Relevance = query–chunk similarity, not a probability that the content is correct." icon={<BookOpen className="size-4" aria-hidden />} />
      <ul className="divide-y divide-line">
        {evidence.map((e) => <EvidenceItem key={e.chunk_id} e={e} compact={compact} />)}
      </ul>
    </Card>
  );
}

function EvidenceItem({ e, compact }: { e: Evidence; compact: boolean }) {
  const untrusted = e.trust === "untrusted_instructions";
  return (
    <li className={cx("px-4 py-2.5", untrusted && "bg-red-50/40")}>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/knowledge/${e.document_id}?chunk=${encodeURIComponent(e.chunk_id)}`} className="text-[13px] font-medium text-indigo-700 hover:underline">
          {e.title}
        </Link>
        <span className="text-xs text-muted">v{e.version}{e.heading ? ` · ${e.heading}` : ""}</span>
        {e.retrieval === "fix_guidance" && <Badge tone="sky">fix guidance</Badge>}
        {untrusted && <Badge tone="red" icon={<ShieldAlert className="size-3.5" aria-hidden />}>Untrusted instructions · not used for grounding</Badge>}
      </div>
      <div className="mt-1.5 flex items-center gap-2" title={`Relevance ${e.relevance.toFixed(3)}`}>
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100" aria-hidden>
          <div className={cx("h-full rounded-full", e.above_threshold ? "bg-indigo-500" : "bg-slate-300")} style={{ width: `${Math.min(100, e.relevance * 100)}%` }} />
        </div>
        <span className="text-[11.5px] text-muted">relevance {e.relevance.toFixed(2)} · {e.above_threshold ? "above threshold" : "below threshold"}</span>
      </div>
      {!compact && <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-[12.5px] text-ink-2">{e.snippet}</p>}
      <p className="mt-1 font-mono text-[10.5px] text-slate-400">{e.chunk_id}</p>
    </li>
  );
}

// ================================================================== conversation
export function Conversation({ d, canReply, onChanged }: { d: WorkflowDetail; canReply: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const pq = d.state.pending_question;
  const awaiting = d.workflow.status === "awaiting_user_input" && !!pq;

  const send = async (content: string) => {
    if (!content.trim()) return;
    setBusy(true);
    try {
      await api.post(`/workflows/${d.workflow.id}/messages`, { content });
      setText("");
      onChanged();
    } catch (e) {
      toast("error", (e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (worked: boolean) => {
    setBusy(true);
    try {
      await api.post(`/workflows/${d.workflow.id}/actions`, { action: worked ? "confirm_fix" : "reopen" });
      onChanged();
    } catch (e) {
      toast("error", (e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const lastQuestionId = [...d.messages].reverse().find((m) => m.kind === "clarification" || m.kind === "confirmation")?.id;

  return (
    <div className="flex min-h-0 flex-col">
      <ol className="flex-1 space-y-3 overflow-y-auto px-1 py-2" aria-live="polite" aria-label="Conversation">
        {d.messages.map((m) => (
          <MessageBubble key={m.id} m={m} active={awaiting && m.id === lastQuestionId && canReply} pending={pq?.kind}
            onSuggest={(s) => void send(s)} onConfirm={confirm} busy={busy} />
        ))}
        {!d.terminal && !d.waiting && (
          <li className="flex items-center gap-2 pl-9 text-xs text-muted"><span className="size-1.5 animate-pulse rounded-full bg-indigo-500" />Working: {WORKFLOW_STATUS[d.workflow.status]?.label}</li>
        )}
      </ol>
      {canReply && !d.terminal && (
        <form onSubmit={(e) => { e.preventDefault(); void send(text); }} className="mt-2 flex items-end gap-2 border-t border-line pt-3">
          <label htmlFor="reply" className="sr-only">Reply</label>
          <Textarea id="reply" rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000}
            placeholder={awaiting ? "Answer the question above…" : "Add a note for the support team…"}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(text); } }} />
          <Button type="submit" variant="primary" loading={busy} disabled={!text.trim()} icon={<Send className="size-4" aria-hidden />} aria-label="Send reply">
            <span className="hidden sm:inline">Send</span>
          </Button>
        </form>
      )}
    </div>
  );
}

function MessageBubble({ m, active, pending, onSuggest, onConfirm, busy }: {
  m: Message; active: boolean; pending?: string; onSuggest: (s: string) => void; onConfirm: (w: boolean) => void; busy: boolean;
}) {
  if (m.author_role === "system") {
    return <li className="mx-auto max-w-[90%] rounded-lg bg-slate-100 px-3 py-1.5 text-center text-xs text-ink-2">{m.content}</li>;
  }
  const mine = m.author_role === "user";
  const who = m.author_role === "assistant" ? "AgentOps assistant" : m.author_role === "engineer" ? (m.author_name ?? "Support engineer") : (m.author_name ?? "You");
  return (
    <li className={cx("flex gap-2", mine && "flex-row-reverse")}>
      {!mine && (
        <span className={cx("mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-white", m.author_role === "engineer" ? "bg-emerald-600" : "bg-navy-800")}>
          {m.author_role === "engineer" ? <UserRoundCog className="size-3.5" aria-hidden /> : <Bot className="size-3.5" aria-hidden />}
        </span>
      )}
      <div className={cx("max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed shadow-sm",
        mine ? "rounded-tr-sm bg-indigo-600 text-white" : "rounded-tl-sm border border-line bg-white text-ink",
        m.kind === "recommendation" && "border-amber-200 bg-amber-50/60",
        m.kind === "notice" && !mine && "bg-slate-50")}>
        <p className={cx("mb-0.5 text-[11px] font-medium", mine ? "text-indigo-100" : "text-muted")}>{who} · {fmtTime(m.created_at)}</p>
        <p className="whitespace-pre-line break-words">{m.content}</p>
        {m.meta.citations && m.meta.citations.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.meta.citations.filter((c, i, all) => all.findIndex((x) => x.document_id === c.document_id) === i).map((c) => (
              <Link key={c.chunk_id} href={`/knowledge/${c.document_id}?chunk=${encodeURIComponent(c.chunk_id)}`}
                className="inline-flex items-center gap-1 rounded-md bg-white px-1.5 py-0.5 text-[11.5px] font-medium text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-50">
                <BookOpen className="size-3" aria-hidden />{c.title} v{c.version}
              </Link>
            ))}
          </div>
        )}
        {active && pending === "clarification" && m.meta.suggestions && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {m.meta.suggestions.map((s) => (
              <button key={s} type="button" disabled={busy} onClick={() => onSuggest(s)}
                className="rounded-full border border-indigo-200 bg-white px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50">{s}</button>
            ))}
          </div>
        )}
        {active && pending === "confirmation" && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button size="sm" variant="success" disabled={busy} onClick={() => onConfirm(true)}>Yes, it works</Button>
            <Button size="sm" disabled={busy} onClick={() => onConfirm(false)}>No, still broken</Button>
          </div>
        )}
      </div>
    </li>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 text-sm font-semibold text-ink">{children}</h2>;
}
