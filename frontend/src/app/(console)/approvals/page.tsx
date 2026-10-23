"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { ApprovalCard } from "@/components/ApprovalCard";
import { Card, cx, EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import type { Approval } from "@/lib/types";

const VIEWS = [
  { id: "pending", label: "Pending" },
  { id: "info_requested", label: "Waiting on requester" },
  { id: "approved,executing,executed", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
];

export default function ApprovalsPage() {
  const [view, setView] = useState("pending");
  const data = useApi<Approval[]>(`/approvals?status=${view}`, [view]);
  useEffect(() => {
    const t = setInterval(() => void data.reload(), 10000);
    return () => clearInterval(t);
  }, [data.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHeader
        title="Human approval queue"
        description="Each approval is bound to one exact action and parameter version. The server re-checks permissions and the parameter hash at decision time and again before execution."
      />
      <div role="radiogroup" aria-label="Approval status" className="mb-4 inline-flex flex-wrap rounded-lg border border-line bg-white p-0.5 shadow-sm">
        {VIEWS.map((v) => (
          <button key={v.id} type="button" role="radio" aria-checked={view === v.id} onClick={() => setView(v.id)}
            className={cx("rounded-md px-3 py-1.5 text-[13px] font-medium", view === v.id ? "bg-navy-900 text-white" : "text-ink-2 hover:bg-slate-50")}>
            {v.label}
          </button>
        ))}
      </div>
      {data.error && <Card><ErrorState error={data.error} onRetry={data.reload} /></Card>}
      {!data.data && !data.error && <Card><LoadingBlock rows={5} /></Card>}
      {data.data?.length === 0 && (
        <Card><EmptyState icon={<ShieldCheck className="size-5" aria-hidden />} title={view === "pending" ? "No actions waiting for approval" : "Nothing here"} body="Sensitive actions appear here when a workflow pauses for a decision." /></Card>
      )}
      <div className="space-y-4">{data.data?.map((a) => <ApprovalCard key={a.id} approval={a} onChanged={data.reload} />)}</div>
    </>
  );
}
