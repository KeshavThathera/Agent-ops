"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, History, Workflow } from "lucide-react";
import { ApprovalCard } from "@/components/ApprovalCard";
import { Badge, Button, Card, CardHeader, ErrorState, Field, Input, LoadingBlock, Notice, Select, StatusBadge, Tabs, useToast } from "@/components/ui";
import { Conversation, EvidenceList, ToolCallsTable } from "@/components/workflow";
import { api, ApiError } from "@/lib/api";
import { fmtDate, label, PRIORITY_TONE, TICKET_STATUS, WORKFLOW_STATUS } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import type { Ticket, User, WorkflowDetail } from "@/lib/types";

interface TicketDetail {
  ticket: Ticket;
  workflow: WorkflowDetail | null;
  history: Array<{ id: number; action: string; actor_name: string | null; actor_role: string; outcome: string; details: Record<string, unknown>; created_at: string }>;
}

type Tab = "conversation" | "diagnostics" | "evidence" | "approvals" | "history";

export default function TicketPage() {
  const { id } = useParams<{ id: string }>();
  const { isStaff, user } = useSession();
  const data = useApi<TicketDetail>(`/tickets/${id}`, [id]);
  const [tab, setTab] = useState<Tab>("conversation");

  if (data.error && !data.data) return <Card><ErrorState error={data.error} onRetry={data.reload} /></Card>;
  if (!data.data) return <Card><LoadingBlock rows={6} /></Card>;
  const { ticket: t, workflow: wf, history } = data.data;

  return (
    <div className="space-y-4">
      <Link href="/tickets" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-4" aria-hidden />Tickets</Link>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-muted">{t.display_id}{t.origin !== "live" && ` · ${t.origin === "seed" ? "seeded demo data" : "evaluation run"}`}</p>
            <h1 className="mt-0.5 text-lg font-semibold text-ink">{t.title}</h1>
            <p className="mt-1 max-w-3xl text-[13.5px] text-ink-2">{t.description}</p>
          </div>
          {wf && (
            <Link href={`/workflows/${wf.workflow.id}`}><Button icon={<Workflow className="size-4" aria-hidden />}>Open execution trace</Button></Link>
          )}
        </div>
        <div className="grid gap-px border-t border-line bg-line text-[13px] sm:grid-cols-2 lg:grid-cols-4">
          <Cell k="Ticket status"><StatusBadge meta={TICKET_STATUS} value={t.status} /></Cell>
          <Cell k="Workflow status"><StatusBadge meta={WORKFLOW_STATUS} value={t.workflow_status} live={false} /></Cell>
          <Cell k="Category · priority"><span className="flex items-center gap-1.5">{label(t.category)} <Badge tone={PRIORITY_TONE[t.priority]}>{t.priority}</Badge></span></Cell>
          <Cell k="Requester">{t.requester?.name}</Cell>
          <Cell k="Assignee">{t.assignee?.name ?? <span className="text-muted">Unassigned</span>}</Cell>
          <Cell k="Created">{fmtDate(t.created_at)}</Cell>
          <Cell k="Updated">{fmtDate(t.updated_at)}</Cell>
          <Cell k="Resolved">{fmtDate(t.resolved_at)}</Cell>
        </div>
        {t.resolution && <div className="border-t border-line px-5 py-3 text-[13px]"><span className="text-muted">Resolution: </span>{t.resolution}</div>}
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <Tabs<Tab> label="Ticket sections" value={tab} onChange={setTab} tabs={[
            { id: "conversation", label: "Conversation", count: wf?.messages.length },
            { id: "diagnostics", label: "Diagnostics", count: wf?.tool_calls.length },
            { id: "evidence", label: "Evidence", count: wf?.evidence.length },
            { id: "approvals", label: "Approvals", count: wf?.approvals.length },
            ...(isStaff ? [{ id: "history" as Tab, label: "History", count: history.length }] : []),
          ]} />
          {!wf && <Notice>No workflow is linked to this ticket.</Notice>}
          {wf && tab === "conversation" && <Card><div className="p-4"><Conversation d={wf} canReply={user?.id === wf.workflow.requester_id || isStaff} onChanged={data.reload} /></div></Card>}
          {wf && tab === "diagnostics" && <ToolCallsTable calls={wf.tool_calls} />}
          {wf && tab === "evidence" && <EvidenceList evidence={wf.evidence} />}
          {wf && tab === "approvals" && (
            <div className="space-y-3">
              {wf.approvals.length === 0 && <Notice>No approvals were required for this ticket.</Notice>}
              {wf.approvals.map((a) => <ApprovalCard key={a.id} approval={a} onChanged={data.reload} />)}
            </div>
          )}
          {tab === "history" && isStaff && (
            <Card>
              <CardHeader title="Audit history" subtitle="Append-only entries for this ticket" icon={<History className="size-4" aria-hidden />} />
              <ol className="divide-y divide-line">
                {history.map((h) => (
                  <li key={h.id} className="px-4 py-2.5 text-[13px]">
                    <p><span className="font-mono text-[12px]">{h.action}</span> · {h.actor_name} <span className="text-muted">({h.actor_role})</span> {h.outcome !== "success" && <Badge tone="red">{h.outcome}</Badge>}</p>
                    <p className="text-xs text-muted">{fmtDate(h.created_at)}</p>
                    {"changes" in h.details && <pre className="mt-1 overflow-x-auto font-mono text-[11.5px] text-ink-2">{JSON.stringify(h.details.changes)}</pre>}
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </div>
        {isStaff && <AssignmentCard t={t} onSaved={data.reload} />}
      </div>
    </div>
  );
}

function Cell({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="bg-white px-5 py-2.5"><p className="text-xs text-muted">{k}</p><div className="mt-0.5">{children}</div></div>;
}

function AssignmentCard({ t, onSaved }: { t: Ticket; onSaved: () => void }) {
  const toast = useToast();
  const staff = useApi<User[]>("/users", []);
  const [priority, setPriority] = useState(t.priority);
  const [assignee, setAssignee] = useState(t.assignee_id ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = priority !== t.priority || assignee !== (t.assignee_id ?? "");
  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/tickets/${t.id}`, {
        priority: priority !== t.priority ? priority : null,
        assignee_id: assignee && assignee !== t.assignee_id ? assignee : null,
        unassign: !assignee && !!t.assignee_id,
        reason: reason || null,
      });
      toast("success", "Ticket updated and recorded in the audit log");
      setReason("");
      onSaved();
    } catch (e) {
      toast("error", (e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="h-fit">
      <CardHeader title="Assignment & priority" subtitle="Changes create audit entries" />
      <div className="space-y-3 px-4 py-4">
        <Field label="Priority" htmlFor="prio">
          <Select id="prio" value={priority} onChange={(e) => setPriority(e.target.value)}>
            {["critical", "high", "medium", "low"].map((p) => <option key={p} value={p}>{label(p)}</option>)}
          </Select>
        </Field>
        <Field label="Assignee" htmlFor="assignee">
          <Select id="assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {staff.data?.filter((u) => u.role !== "employee").map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
          </Select>
        </Field>
        <Field label="Reason (optional)" htmlFor="reason"><Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
        <Button variant="primary" className="w-full" disabled={!dirty} loading={busy} onClick={save}>Save changes</Button>
      </div>
    </Card>
  );
}
