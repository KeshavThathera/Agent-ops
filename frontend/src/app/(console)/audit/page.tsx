"use client";

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Badge, Card, EmptyState, ErrorState, Input, Json, LoadingBlock, Notice, PageHeader, Pagination, Select } from "@/components/ui";
import { qs } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import type { AuditEvent, Page } from "@/lib/types";

const ACTIONS = [
  ["", "All actions"], ["approval.", "Approval decisions"], ["policy.", "Policy changes"], ["knowledge.", "Knowledge uploads & changes"],
  ["tool.", "Tool executions & blocks"], ["request.", "Requests (incl. blocked)"], ["workflow.", "Workflow actions & failures"],
  ["ticket.", "Ticket changes"], ["auth.", "Sign-ins"], ["settings.", "Settings"], ["evaluation.", "Evaluations"], ["demo.", "Demo resets"],
];

export default function AuditPage() {
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState("");
  const [origin, setOrigin] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { const t = setTimeout(() => { setQuery(q); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const path = `/audit${qs({ action, outcome, origin, q: query, page, page_size: 30 })}`;
  const data = useApi<Page<AuditEvent>>(path, [path]);

  return (
    <>
      <PageHeader title="Audit log" description="Append-only application audit trail with sanitised details. Secrets and PII are redacted before storage." />
      <div className="mb-4"><Notice>The application never updates or deletes audit rows (enforced in code and by the absence of any edit API). This is not cryptographic tamper-proofing: direct database access could still alter rows.</Notice></div>
      <Card className="overflow-hidden">
        <div className="grid gap-2 border-b border-line p-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="relative block">
            <span className="sr-only">Search audit log</span>
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-slate-400" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search action, actor or resource" className="pl-8" />
          </label>
          <Select aria-label="Action type" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>{ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
          <Select aria-label="Outcome" value={outcome} onChange={(e) => { setOutcome(e.target.value); setPage(1); }}>
            <option value="">All outcomes</option><option value="success">Success</option><option value="denied">Denied</option><option value="failure">Failure</option>
          </Select>
          <Select aria-label="Data source" value={origin} onChange={(e) => { setOrigin(e.target.value); setPage(1); }}>
            <option value="">All sources</option><option value="live">Live</option><option value="seed">Seed</option><option value="eval">Evaluation</option>
          </Select>
        </div>
        {data.error && <ErrorState error={data.error} onRetry={data.reload} />}
        {!data.data && !data.error && <LoadingBlock rows={8} />}
        {data.data?.items.length === 0 && <EmptyState title="No audit entries match" />}
        {!!data.data?.items.length && (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full text-[13px]">
                <thead className="bg-slate-50 text-left text-xs text-muted">
                  <tr>{["Time", "Actor", "Role", "Action", "Resource", "Workflow / ticket", "Outcome", ""].map((h) => <th key={h} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.data.items.map((a) => (
                    <Fragment key={a.id}>
                      <tr className="hover:bg-slate-50/70">
                        <td className="whitespace-nowrap px-3 py-2 text-muted">{fmtDate(a.created_at)}</td>
                        <td className="whitespace-nowrap px-3 py-2">{a.actor_name ?? "—"}</td>
                        <td className="px-3 py-2"><Badge tone={a.actor_role === "agent" ? "indigo" : a.actor_role === "system" ? "slate" : "sky"}>{a.actor_role}</Badge></td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px]">{a.action}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-xs">{a.resource_type}{a.resource_id && <span className="block font-mono text-[11px] text-muted">{a.resource_id}</span>}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-xs">
                          {a.workflow_id && <Link href={`/workflows/${a.workflow_id}`} className="block font-mono text-indigo-700 hover:underline">{a.workflow_id.slice(-10)}</Link>}
                          {a.ticket_id && <Link href={`/tickets/${a.ticket_id}`} className="text-indigo-700 hover:underline">ticket</Link>}
                        </td>
                        <td className="px-3 py-2"><Badge tone={a.outcome === "success" ? "green" : a.outcome === "denied" ? "red" : "amber"}>{a.outcome}</Badge></td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id} className="text-xs font-medium text-indigo-700 hover:underline">
                            {open === a.id ? "Hide" : "Details"}
                          </button>
                        </td>
                      </tr>
                      {open === a.id && <tr><td colSpan={8} className="bg-slate-50/70 px-3 py-3"><Json value={a.details} /></td></tr>}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={30} total={data.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
