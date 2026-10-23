"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, BookOpen, CheckCircle2, MessageCircleQuestion, Pencil, Stethoscope, Target, XCircle } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { APPROVAL_STATUS, fmtDate, label, RISK_TONE } from "@/lib/format";
import type { Approval } from "@/lib/types";
import { Badge, Button, Card, cx, Dialog, Field, Input, Notice, StatusBadge, Textarea, useToast } from "./ui";

type Decision = "approve" | "reject" | "request_info";

export function ApprovalCard({ approval, onChanged, compact = false }: { approval: Approval; onChanged: () => void; compact?: boolean }) {
  const toast = useToast();
  const [dialog, setDialog] = useState<Decision | "edit" | null>(null);
  const [reason, setReason] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = approval;
  const inner = (a.parameters.parameters ?? {}) as Record<string, unknown>;
  const pending = a.status === "pending";
  const reasonRequired = dialog === "reject" || dialog === "request_info" || (dialog === "approve" && a.reason_required);

  const open = (d: Decision | "edit") => {
    setError(null);
    setReason("");
    setParams(Object.fromEntries(Object.entries(inner).map(([k, v]) => [k, String(v)])));
    setDialog(d);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (dialog === "edit") {
        const typed = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v === "true" ? true : v === "false" ? false : v]));
        await api.post(`/approvals/${a.id}/parameters`, { parameters: typed, reason });
        toast("info", "Parameters changed. The previous approval was invalidated and a new version is pending.");
      } else {
        await api.post(`/approvals/${a.id}/decision`, { decision: dialog, reason: reason || null, params_hash: a.params_hash });
        toast("success", dialog === "approve" ? "Approved. The workflow resumes from its checkpoint." : dialog === "reject" ? "Rejected. The action will not run." : "Question sent to the requester.");
      }
      setDialog(null);
      onChanged();
    } catch (e) {
      const err = e as ApiError;
      setError(err.message);
      if (err.status === 409) onChanged();
    } finally {
      setBusy(false);
    }
  };

  const diag = a.evidence.find((e) => e.kind === "diagnosis");
  const kb = a.evidence.filter((e) => e.kind === "kb");

  return (
    <Card as="article" className={cx(pending && "ring-1 ring-amber-200")}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge meta={APPROVAL_STATUS} value={a.status} />
            <Badge tone={RISK_TONE[a.risk_level]} icon={<AlertTriangle className="size-3.5" aria-hidden />}>{label(a.risk_level)} risk</Badge>
            <Badge tone="slate">{a.policy_id}</Badge>
            <span className="text-xs text-muted">v{a.action_version} · hash {a.params_hash.slice(0, 10)}</span>
          </div>
          <h3 className="mt-1.5 text-[15px] font-semibold text-ink">{a.action_summary}</h3>
          <p className="mt-0.5 text-[13px] text-muted">
            {a.requester_name} · {a.ticket_number ? <Link className="text-indigo-700 hover:underline" href={`/tickets/${a.ticket_id}`}>TKT-{a.ticket_number}</Link> : "no ticket"} ·{" "}
            <Link className="text-indigo-700 hover:underline" href={`/workflows/${a.workflow_id}`}>workflow</Link> · requested {fmtDate(a.created_at)}
          </p>
        </div>
        {pending && a.can_decide && (
          <div className="flex flex-wrap gap-2">
            <Button variant="success" size="sm" icon={<CheckCircle2 className="size-4" aria-hidden />} onClick={() => open("approve")}>Approve</Button>
            <Button variant="danger" size="sm" icon={<XCircle className="size-4" aria-hidden />} onClick={() => open("reject")}>Reject</Button>
            <Button size="sm" icon={<MessageCircleQuestion className="size-4" aria-hidden />} onClick={() => open("request_info")}>Request info</Button>
            {Object.keys(inner).length > 0 && <Button size="sm" variant="ghost" icon={<Pencil className="size-4" aria-hidden />} onClick={() => open("edit")}>Edit parameters</Button>}
          </div>
        )}
      </div>

      <div className={cx("grid gap-4 px-4 py-3.5", !compact && "lg:grid-cols-2")}>
        <div className="space-y-3 text-[13px]">
          {a.request_text && !compact && <p className="rounded-lg bg-slate-50 px-3 py-2 italic text-ink-2">“{a.request_text}”</p>}
          <dl className="grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-muted">Exact action</dt><dd className="font-mono text-[12px]">{a.tool_name} → {a.action}</dd>
            <dt className="text-muted">Target resource</dt><dd className="flex items-center gap-1 font-mono text-[12px]"><Target className="size-3.5 text-muted" aria-hidden />{a.target_resource} <span className="font-sans text-[11px] text-amber-700">(sandbox)</span></dd>
            <dt className="text-muted">Validated parameters</dt>
            <dd>
              {Object.keys(inner).length === 0 ? <span className="text-muted">none</span> : (
                <ul className="space-y-0.5 font-mono text-[12px]">{Object.entries(inner).map(([k, v]) => <li key={k}>{k} = {String(v)}</li>)}</ul>
              )}
            </dd>
            <dt className="text-muted">Policy</dt><dd>{a.policy_text}. Approver roles: {a.approver_roles.join(", ")}{a.reason_required && "; reason required"}</dd>
            <dt className="text-muted">Expected effect</dt><dd>{a.expected_effect}</dd>
          </dl>
          {a.decided_at && (
            <Notice tone={a.status === "rejected" ? "red" : "green"}>
              {a.decided_by_name} {a.status === "rejected" ? "rejected" : a.status === "info_requested" ? "asked a question" : "approved"} on {fmtDate(a.decided_at)}
              {a.decision_reason && <> — “{a.decision_reason}”</>}
              {a.executed_at && <> · executed {fmtDate(a.executed_at)}</>}
            </Notice>
          )}
          {pending && !a.can_decide && (
            <p className="text-xs text-muted">You can view this approval but cannot decide it (requires {a.approver_roles.join(" or ")}; requesters cannot approve their own requests).</p>
          )}
        </div>
        <div className="space-y-2.5 text-[13px]">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Supporting evidence</p>
          {diag?.text && (
            <div className="rounded-lg border border-line p-2.5">
              <p className="flex items-center gap-1.5 font-medium"><Stethoscope className="size-3.5 text-indigo-600" aria-hidden />Diagnosis</p>
              <p className="mt-1 text-ink-2">{diag.text}</p>
              {diag.verifier?.detail && (
                <p className={cx("mt-1 text-xs", diag.verifier.supported ? "text-emerald-700" : "text-red-700")}>
                  Verifier: {diag.verifier.detail}
                </p>
              )}
            </div>
          )}
          {kb.map((e) => (
            <Link key={e.chunk_id} href={`/knowledge/${e.document_id}?chunk=${encodeURIComponent(e.chunk_id ?? "")}`}
              className="block rounded-lg border border-line p-2.5 hover:border-indigo-300 hover:bg-indigo-50/30">
              <p className="flex items-center gap-1.5 font-medium"><BookOpen className="size-3.5 text-indigo-600" aria-hidden />{e.title} <span className="font-normal text-muted">v{e.version}</span></p>
              <p className="mt-1 line-clamp-2 text-xs text-muted">{e.snippet}</p>
            </Link>
          ))}
        </div>
      </div>

      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog === "approve" ? "Approve action" : dialog === "reject" ? "Reject action" : dialog === "edit" ? "Edit action parameters" : "Request more information"}
        description={<span>{a.action_summary} on <span className="font-mono">{a.target_resource}</span></span>}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              variant={dialog === "reject" ? "danger" : dialog === "approve" ? "success" : "primary"}
              loading={busy}
              disabled={(reasonRequired || dialog === "edit") && reason.trim().length < 3}
              onClick={submit}
            >
              {dialog === "approve" ? "Approve and resume" : dialog === "reject" ? "Reject" : dialog === "edit" ? "Save new version" : "Send question"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <Notice tone="red" title="Not applied">{error}</Notice>}
          {dialog === "approve" && (
            <Notice tone="amber">This approval is bound to parameter version v{a.action_version} (hash {a.params_hash.slice(0, 12)}…). If the action changes, it is invalidated automatically.</Notice>
          )}
          {dialog === "edit" && (
            <>
              <Notice tone="amber">Saving creates version v{a.action_version + 1}. The current approval request is invalidated and must be approved again.</Notice>
              {Object.entries(params).map(([k, v]) => (
                <Field key={k} label={k} htmlFor={`p-${k}`}>
                  <Input id={`p-${k}`} value={v} onChange={(e) => setParams({ ...params, [k]: e.target.value })} />
                </Field>
              ))}
            </>
          )}
          <Field
            label={dialog === "request_info" ? "Question for the requester" : "Reason"}
            htmlFor="decision-reason"
            required={reasonRequired || dialog === "edit"}
            hint={dialog === "approve" && a.reason_required ? "Sensitive action: record how you verified it (for example, identity callback)." : undefined}
          >
            <Textarea id="decision-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}
