"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, FlaskConical, ShieldCheck } from "lucide-react";
import { ApprovalCard } from "@/components/ApprovalCard";
import { Button, Card, CardHeader, ErrorState, LoadingBlock, Notice, SimulatedTag, Tabs, useToast } from "@/components/ui";
import {
  Conversation, DecisionPanel, EvidenceList, PlanSteps, StageStepper, Timeline, ToolCallsTable, VerificationCard, WorkflowHeader,
} from "@/components/workflow";
import { api, ApiError } from "@/lib/api";
import { APPROVAL_STATUS, fmtDate } from "@/lib/format";
import { useWorkflow } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import type { WorkflowDetail } from "@/lib/types";
import { StatusBadge } from "@/components/ui";

type Tab = "trace" | "tools" | "conversation" | "approvals";

export default function WorkflowPage() {
  const { id } = useParams<{ id: string }>();
  const { user, isStaff } = useSession();
  const wf = useWorkflow(id);
  const [tab, setTab] = useState<Tab>("trace");

  if (wf.error && !wf.data) return <Card><ErrorState error={wf.error} onRetry={wf.reload} /></Card>;
  if (!wf.data) return <Card><LoadingBlock rows={6} /></Card>;
  const d = wf.data;
  const pending = d.approvals.filter((a) => a.status === "pending");

  return (
    <div className="space-y-4">
      <Link href={isStaff ? "/workflows" : `/support?wf=${d.workflow.id}`} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden />{isStaff ? "All workflows" : "Back to conversation"}
      </Link>
      <WorkflowHeader d={d} stream={wf.stream} onChanged={wf.reload} staffView={isStaff} />
      <Card><div className="px-4 py-3 sm:px-5"><StageStepper d={d} /></div></Card>
      {d.error && <ErrorBanner d={d} isRequester={user?.id === d.workflow.requester_id} />}
      {pending.map((a) => <ApprovalCard key={a.id} approval={a} onChanged={wf.reload} compact />)}

      <Tabs<Tab>
        label="Workflow sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "trace", label: "Execution trace" },
          { id: "tools", label: "Tool calls", count: d.tool_calls.length },
          { id: "conversation", label: "Conversation", count: d.messages.length },
          { id: "approvals", label: "Approvals", count: d.approvals.length },
        ]}
      />

      {tab === "trace" && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-w-0 space-y-4">
            <PlanSteps d={d} />
            <Timeline events={d.events} />
          </div>
          <div className="min-w-0 space-y-4">
            <DecisionPanel d={d} />
            <VerificationCard d={d} />
            <CheckpointList d={d} />
            <EvidenceList evidence={d.evidence} compact />
            <SandboxCard d={d} />
          </div>
        </div>
      )}
      {tab === "tools" && <ToolCallsTable calls={d.tool_calls} />}
      {tab === "conversation" && (
        <Card><div className="p-4"><Conversation d={d} canReply={user?.id === d.workflow.requester_id || isStaff} onChanged={wf.reload} /></div></Card>
      )}
      {tab === "approvals" && (
        <div className="space-y-3">
          {d.approvals.length === 0 && <Card><p className="px-4 py-6 text-center text-sm text-muted">No approval checkpoints in this workflow. Policy allowed every executed step automatically.</p></Card>}
          {d.approvals.map((a) => <ApprovalCard key={a.id} approval={a} onChanged={wf.reload} />)}
        </div>
      )}
    </div>
  );
}

function ErrorBanner({ d, isRequester }: { d: WorkflowDetail; isRequester: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const rerun = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ workflow_id: string }>(`/workflows/${d.workflow.id}/demo-rerun`);
      router.push(`/workflows/${r.workflow_id}`);
    } catch (e) {
      toast("error", (e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Notice tone="red" title={`Workflow failed · ${d.error!.code}`}>
      <p>{d.error!.message}</p>
      <p className="mt-1 text-xs">
        {d.error!.retryable ? "The failed step is idempotent, so a support engineer can retry it safely." : "This failure is not retried automatically."}
        {" "}The request and its history are preserved.
      </p>
      {d.state.offer_demo_run && isRequester && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={rerun} loading={busy}>Start a separate demo run</Button>
          <span className="text-xs">This live run will not be switched to simulation automatically.</span>
        </div>
      )}
    </Notice>
  );
}

function CheckpointList({ d }: { d: WorkflowDetail }) {
  return (
    <Card>
      <CardHeader title="Approval checkpoints" icon={<ShieldCheck className="size-4" aria-hidden />} />
      {d.approvals.length === 0 ? (
        <p className="px-4 py-3.5 text-[13px] text-muted">None. Every executed action was automatic under policy.</p>
      ) : (
        <ul className="divide-y divide-line">
          {d.approvals.map((a) => (
            <li key={a.id} className="px-4 py-2.5 text-[13px]">
              <div className="flex flex-wrap items-center gap-2"><StatusBadge meta={APPROVAL_STATUS} value={a.status} /><span className="font-medium">{a.action_summary}</span></div>
              <p className="mt-1 text-xs text-muted">
                {a.policy_id} · v{a.action_version} · hash {a.params_hash.slice(0, 10)}
                {a.decided_by_name && <> · {a.decided_by_name}, {fmtDate(a.decided_at)}</>}
              </p>
              {a.decision_reason && <p className="mt-0.5 text-xs text-ink-2">“{a.decision_reason}”</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SandboxCard({ d }: { d: WorkflowDetail }) {
  const sb = d.state.sandbox;
  if (!sb) return null;
  return (
    <Card>
      <CardHeader title="Sandbox resources" icon={<FlaskConical className="size-4" aria-hidden />} actions={<SimulatedTag />} />
      <div className="space-y-1.5 px-4 py-3.5 text-[13px]">
        <p>Fixture: <span className="font-medium">{sb.fixture}</span></p>
        <ul className="space-y-0.5 font-mono text-[12px] text-ink-2">
          <li>laptop · {sb.device_id}</li><li>account · {sb.account_id}</li><li>printer · {sb.printer_id}</li>
        </ul>
        <p className="text-xs text-muted">Simulated records in the application database. No real device, account or printer is inspected or changed, including your own computer.</p>
      </div>
    </Card>
  );
}
