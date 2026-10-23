"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination, Select, StatusBadge } from "@/components/ui";
import { qs } from "@/lib/api";
import { fmtDate, fmtMs, label, WORKFLOW_STATUS } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import type { Page, WorkflowSummary } from "@/lib/types";

const FILTERS = [
  { v: "", l: "All statuses" },
  { v: "received,classifying,retrieving,planning,diagnosing,executing,verifying", l: "Running" },
  { v: "awaiting_approval", l: "Awaiting approval" },
  { v: "awaiting_user_input", l: "Awaiting user input" },
  { v: "awaiting_human_review", l: "Human review" },
  { v: "completed", l: "Completed" },
  { v: "escalated", l: "Escalated" },
  { v: "failed", l: "Failed" },
  { v: "blocked", l: "Blocked" },
  { v: "cancelled", l: "Cancelled" },
];

export default function WorkflowsPage() {
  const { isStaff } = useSession();
  const [status, setStatus] = useState("");
  const [origin, setOrigin] = useState("live,seed");
  const [page, setPage] = useState(1);
  const path = `/workflows${qs({ status, origin, page, page_size: 20 })}`;
  const data = useApi<Page<WorkflowSummary>>(path, [path]);

  return (
    <>
      <PageHeader title={isStaff ? "Workflows" : "My workflows"} description="Every support request runs as a persisted workflow. Open one to see its plan, tool calls, approvals and verification." />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto">
            {FILTERS.map((f) => <option key={f.l} value={f.v}>{f.l}</option>)}
          </Select>
          <Select aria-label="Data source" value={origin} onChange={(e) => { setOrigin(e.target.value); setPage(1); }} className="w-auto">
            <option value="live,seed">Live + seeded</option><option value="live">Live runs</option><option value="seed">Seeded demo</option><option value="eval">Evaluation runs</option>
          </Select>
        </div>
        {data.error && <ErrorState error={data.error} onRetry={data.reload} />}
        {!data.data && !data.error && <LoadingBlock rows={6} />}
        {data.data?.items.length === 0 && <EmptyState title="No workflows" body="Submit a support request to start one." />}
        {!!data.data?.items.length && (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full text-[13px]">
                <thead className="bg-slate-50 text-left text-xs text-muted">
                  <tr>{["Request", "Status", "Category", "Ticket", "Mode", "Requester", "Retries", "Automated time", "Created"].map((h) => <th key={h} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.data.items.map((w) => (
                    <tr key={w.id} className="hover:bg-slate-50/70">
                      <td className="max-w-[22rem] px-3 py-2.5">
                        <Link href={`/workflows/${w.id}`} className="line-clamp-1 font-medium text-indigo-700 hover:underline">{w.original_request}</Link>
                        <span className="font-mono text-[11px] text-muted">{w.id}</span>
                      </td>
                      <td className="px-3 py-2.5"><StatusBadge meta={WORKFLOW_STATUS} value={w.status} /></td>
                      <td className="whitespace-nowrap px-3 py-2.5">{label(w.category)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5">{w.ticket_number ? <Link className="hover:underline" href={`/tickets/${w.ticket_id}`}>TKT-{w.ticket_number}</Link> : "—"}</td>
                      <td className="px-3 py-2.5"><Badge tone={w.mode === "live" ? "indigo" : "amber"}>{w.mode}</Badge>{w.origin !== "live" && <span className="ml-1 text-[11px] text-muted">{w.origin}</span>}</td>
                      <td className="whitespace-nowrap px-3 py-2.5">{w.requester_name}</td>
                      <td className="px-3 py-2.5 tabular-nums">{w.retry_count}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{fmtMs(w.active_ms)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-muted">{fmtDate(w.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={20} total={data.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
