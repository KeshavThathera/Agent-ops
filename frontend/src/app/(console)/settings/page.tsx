"use client";

import { useState } from "react";
import { AlertTriangle, Bell, Cpu, FlaskConical, Gauge, Lock, RotateCcw, Search, ShieldCheck, UserRound } from "lucide-react";
import { Badge, Button, Card, CardHeader, Dialog, ErrorState, Field, Input, LoadingBlock, Notice, PageHeader, Select, Toggle, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { label } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { useSession } from "@/lib/session";

type Section = Record<string, number | string | null>;
interface SettingsResp {
  profile: { id: string; name: string; email: string; role: string; department: string | null; preferences: { notifications?: Record<string, boolean> } };
  server: { app_env: string; llm_configured: boolean; llm_provider: string; retrieval_backend: string; demo_accounts_enabled: boolean; database: string };
  runtime?: Record<string, Section>;
  policies?: Array<{ id: string; action_class: string; description: string; decision: string; default_decision: string; editable: boolean; editable_values: string[]; risk_level: string }>;
  models?: Record<string, string>;
}

const NOTIFS: Array<[string, string]> = [
  ["approval_requested", "Approval requested"], ["human_review", "Case routed to human review"], ["workflow_failed", "Workflow failed"],
  ["clarification", "Clarification needed from me"], ["confirmation", "Confirm a fix"], ["resolved", "My issue resolved"],
  ["escalated", "My issue escalated"], ["assigned", "Ticket assigned to me"], ["policy_denied", "Unsafe request blocked"],
];

export default function SettingsPage() {
  const { isAdmin, refresh } = useSession();
  const data = useApi<SettingsResp>("/settings", []);
  if (data.error) return <Card><ErrorState error={data.error} onRetry={data.reload} /></Card>;
  if (!data.data) return <Card><LoadingBlock rows={6} /></Card>;
  const s = data.data;
  return (
    <>
      <PageHeader title="Settings" description="Provider secrets live only in the server environment. Nothing on this page reads, stores or displays an API key." />
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Profile & role" icon={<UserRound className="size-4" aria-hidden />} />
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 px-4 py-4 text-[13px]">
            <dt className="text-muted">Name</dt><dd>{s.profile.name}</dd>
            <dt className="text-muted">Email</dt><dd>{s.profile.email}</dd>
            <dt className="text-muted">Role</dt><dd><Badge tone="indigo">{s.profile.role}</Badge> <span className="text-xs text-muted">Enforced by the server on every request.</span></dd>
            <dt className="text-muted">Department</dt><dd>{s.profile.department ?? "—"}</dd>
          </dl>
        </Card>
        <NotificationPrefs initial={s.profile.preferences.notifications ?? {}} onSaved={refresh} />
        <Card>
          <CardHeader title="Model & provider status" icon={<Cpu className="size-4" aria-hidden />} />
          <div className="space-y-2 px-4 py-4 text-[13px]">
            <p>Provider: <span className="font-medium">{s.server.llm_provider}</span> · {s.server.llm_configured ? <Badge tone="green">credentials configured on server</Badge> : <Badge tone="amber">not configured — demo mode only</Badge>}</p>
            <p>Retrieval: <span className="font-medium">{s.server.retrieval_backend === "chroma" ? "ChromaDB vector search" : "deterministic keyword (TF-IDF)"}</span> · Database: {s.server.database} · Environment: {s.server.app_env}</p>
            {s.models && <p className="text-muted">Classifier model <span className="font-mono text-ink">{s.models.classifier}</span> · planner model <span className="font-mono text-ink">{s.models.planner}</span></p>}
          </div>
          {isAdmin && s.runtime && <ModelRouting value={s.runtime.model_routing} onSaved={data.reload} />}
        </Card>
        {isAdmin && s.runtime && (
          <>
            <SectionForm key={JSON.stringify(s.runtime.retrieval)} title="Retrieval thresholds" icon={<Search className="size-4" aria-hidden />} section="retrieval" value={s.runtime.retrieval} onSaved={data.reload}
              fields={[["top_k", "Top-k chunks", 1], ["min_relevance", "Minimum relevance (similarity)", 0.01]]} />
            <SectionForm key={JSON.stringify(s.runtime.execution)} title="Execution limits" icon={<Gauge className="size-4" aria-hidden />} section="execution" value={s.runtime.execution} onSaved={data.reload}
              fields={[["max_steps", "Max plan steps", 1], ["max_active_seconds", "Max automated seconds per workflow", 1], ["tool_timeout_seconds", "Tool timeout (MCP calls), seconds", 1], ["max_clarifications", "Max clarification rounds", 1]]} />
            <SectionForm key={JSON.stringify(s.runtime.retry)} title="Retry policy" icon={<RotateCcw className="size-4" aria-hidden />} section="retry" value={s.runtime.retry} onSaved={data.reload}
              note="Applies to transient errors of idempotent tools only. Permission errors, invalid requests and non-idempotent side effects are never retried automatically."
              fields={[["max_attempts", "Max attempts", 1], ["base_backoff_seconds", "Base backoff (s, doubles each retry)", 0.1], ["max_backoff_seconds", "Max backoff (s)", 0.5]]} />
            <RiskPolicies policies={s.policies ?? []} onSaved={data.reload} />
            <DemoControls value={s.runtime.demo} onSaved={data.reload} />
            {s.server.demo_accounts_enabled && <ResetCard />}
          </>
        )}
      </div>
    </>
  );
}

function useSave(section: string, onSaved: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.put(`/settings/${section}`, body);
      toast("success", "Saved and recorded in the audit log");
      onSaved();
    } catch (e) { toast("error", (e as ApiError).message); }
    finally { setBusy(false); }
  };
  return { busy, save };
}

function SectionForm({ title, icon, section, value, fields, onSaved, note }: {
  title: string; icon: React.ReactNode; section: string; value: Section; fields: Array<[string, string, number]>; onSaved: () => void; note?: string;
}) {
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(([k]) => [k, String(value[k] ?? "")])));
  const { busy, save } = useSave(section, onSaved);
  return (
    <Card>
      <CardHeader title={title} icon={icon} />
      <form className="space-y-3 px-4 py-4" onSubmit={(e) => { e.preventDefault(); void save(Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v)]))); }}>
        {note && <p className="text-xs text-muted">{note}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map(([k, l, step]) => (
            <Field key={k} label={l} htmlFor={`${section}-${k}`}>
              <Input id={`${section}-${k}`} type="number" step={step} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        <div className="flex justify-end"><Button type="submit" variant="primary" size="sm" loading={busy}>Save</Button></div>
      </form>
    </Card>
  );
}

function ModelRouting({ value, onSaved }: { value: Section; onSaved: () => void }) {
  const [c, setC] = useState(String(value.classifier_model ?? ""));
  const [p, setP] = useState(String(value.planner_model ?? ""));
  const { busy, save } = useSave("model_routing", onSaved);
  return (
    <form className="space-y-3 border-t border-line px-4 py-4" onSubmit={(e) => { e.preventDefault(); void save({ classifier_model: c || null, planner_model: p || null }); }}>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Model routing (live mode)</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Lightweight classifier model" htmlFor="m-c" hint="Blank = LLM_CLASSIFIER_MODEL"><Input id="m-c" value={c} onChange={(e) => setC(e.target.value)} placeholder="claude-haiku-5-5" /></Field>
        <Field label="Planner / diagnosis model" htmlFor="m-p" hint="Blank = LLM_PLANNER_MODEL"><Input id="m-p" value={p} onChange={(e) => setP(e.target.value)} placeholder="claude-opus-5-5" /></Field>
      </div>
      <p className="text-xs text-muted">Embeddings: ChromaDB&apos;s local all-MiniLM-L6-v2 model when RETRIEVAL_BACKEND=chroma. Verification is deterministic whenever the outcome is measurable.</p>
      <div className="flex justify-end"><Button type="submit" size="sm" variant="primary" loading={busy}>Save routing</Button></div>
    </form>
  );
}

function RiskPolicies({ policies, onSaved }: { policies: NonNullable<SettingsResp["policies"]>; onSaved: () => void }) {
  const { busy, save } = useSave("risk_policy", onSaved);
  return (
    <Card>
      <CardHeader title="Risk policies" subtitle="Changes are audited as policy.changed. Locked policies cannot be changed in this prototype." icon={<ShieldCheck className="size-4" aria-hidden />} />
      <ul className="divide-y divide-line">
        {policies.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
            <span className="min-w-0"><span className="font-mono text-[12px] text-muted">{p.id}</span> <span className="block">{p.description}</span></span>
            {p.editable ? (
              <Select aria-label={`Decision for ${p.description}`} className="w-auto" value={p.decision} disabled={busy}
                onChange={(e) => void save({ [p.action_class]: e.target.value })}>
                {p.editable_values.map((v) => <option key={v} value={v}>{label(v)}{v === p.default_decision ? " (default)" : ""}</option>)}
              </Select>
            ) : (
              <span className="flex items-center gap-1.5"><Badge tone={p.decision === "automatic" ? "green" : p.decision === "approval_required" ? "amber" : "red"}>{label(p.decision)}</Badge><Lock className="size-3.5 text-slate-400" aria-label="Locked" /></span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DemoControls({ value, onSaved }: { value: Section; onSaved: () => void }) {
  const { busy, save } = useSave("demo", onSaved);
  return (
    <Card>
      <CardHeader title="Demo scenario controls" subtitle="Global defaults for new workflows. Per-request options in the Support Workspace override them." icon={<FlaskConical className="size-4" aria-hidden />} />
      <div className="grid gap-3 px-4 py-4 sm:grid-cols-3">
        <Field label="Ticketing API" htmlFor="d-t">
          <Select id="d-t" value={String(value.ticketing_fault)} disabled={busy} onChange={(e) => void save({ ticketing_fault: e.target.value })}>
            <option value="none">Healthy</option><option value="transient">Transient failure</option><option value="permanent">Sustained outage</option>
          </Select>
        </Field>
        <Field label="Remediation outcome" htmlFor="d-v">
          <Select id="d-v" value={String(value.verification_fault)} disabled={busy} onChange={(e) => void save({ verification_fault: e.target.value })}>
            <option value="none">Effective</option><option value="ineffective">Ineffective</option>
          </Select>
        </Field>
        <Field label="Read-only tool transport" htmlFor="d-x" hint="MCP launches app.mcp_server over stdio for each call">
          <Select id="d-x" value={String(value.tool_transport)} disabled={busy} onChange={(e) => void save({ tool_transport: e.target.value })}>
            <option value="in_process">In-process</option><option value="mcp">MCP (stdio)</option>
          </Select>
        </Field>
      </div>
    </Card>
  );
}

function ResetCard() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    setBusy(true);
    try {
      await api.post("/admin/reset-demo", { confirm });
      toast("success", "Demo data reset and reseeded. The audit log was kept.");
      // Full reload on purpose: every piece of client state must start fresh for the new identity.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      setTimeout(() => window.location.assign("/"), 600);
    } catch (e) { toast("error", (e as ApiError).message); }
    finally { setBusy(false); }
  };
  return (
    <Card className="border-red-200">
      <CardHeader title="Reset demo data" icon={<AlertTriangle className="size-4 text-red-600" aria-hidden />} />
      <div className="space-y-3 px-4 py-4 text-[13px]">
        <p>Deletes tickets, workflows, approvals, uploads and evaluation runs, then restores the seed data. The append-only audit log is kept and records the reset. Other users are signed out.</p>
        <Button variant="danger" onClick={() => { setConfirm(""); setOpen(true); }}>Reset demo data…</Button>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title="Reset all demo data?" description="This cannot be undone."
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" loading={busy} disabled={confirm !== "RESET DEMO DATA"} onClick={reset}>Reset</Button></>}>
        <Notice tone="red">Type <span className="font-mono font-semibold">RESET DEMO DATA</span> to confirm.</Notice>
        <div className="mt-3"><Field label="Confirmation" htmlFor="reset-confirm"><Input id="reset-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" /></Field></div>
      </Dialog>
    </Card>
  );
}

function NotificationPrefs({ initial, onSaved }: { initial: Record<string, boolean>; onSaved: () => void }) {
  const toast = useToast();
  const [prefs, setPrefs] = useState<Record<string, boolean>>(initial);
  const set = async (k: string, v: boolean) => {
    setPrefs({ ...prefs, [k]: v });
    try { await api.put("/me/preferences", { notifications: { [k]: v } }); onSaved(); }
    catch (e) { toast("error", (e as ApiError).message); setPrefs(prefs); }
  };
  return (
    <Card>
      <CardHeader title="Notification preferences" subtitle="In-app notifications. Email, Slack and Teams delivery are not configured." icon={<Bell className="size-4" aria-hidden />} />
      <ul className="divide-y divide-line">
        {NOTIFS.map(([k, l]) => (
          <li key={k} className="flex items-center justify-between px-4 py-2 text-[13px]">
            <span>{l}</span>
            <Toggle label={l} checked={prefs[k] !== false} onChange={(v) => void set(k, v)} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
