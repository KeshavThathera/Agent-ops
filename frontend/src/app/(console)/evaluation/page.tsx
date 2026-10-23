"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Download, FlaskConical, Play } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Button, Card, CardHeader, cx, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader, Select, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { fmtDate, fmtMs, fmtPct, label } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import type { Rate } from "@/lib/types";

type Summary = Record<string, Rate | number | null>;
interface Run { id: string; mode: string; systems: string[]; status: string; dataset_version: string; summary: Record<string, Summary>; error: string | null; created_at: string; started_at: string | null; finished_at: string | null; model_config?: Record<string, unknown> }
interface Overview { runs: Run[]; definitions: Record<string, string>; dataset_version: string; cases: Array<{ key: string; title: string; input: string; expected: { outcome: string } }> }
interface ResultRow { case_key: string; case_title: string; input: string; expected: { outcome: string; tools: string[]; approval: boolean; escalate: boolean }; system: string; outcome: string; passed: boolean; checks: Record<string, unknown>; claims: Array<{ text: string; label: string; label_reason: string }>; tools_called: string[]; workflow_id: string | null; duration_ms: number; input_tokens: number; output_tokens: number; cost_usd: number }
interface RunDetail { run: Run & { model_config: Record<string, unknown> }; results: ResultRow[]; definitions: Record<string, string> }

const METRICS: Array<[string, string]> = [
  ["task_completion_rate", "Task completion rate"], ["workflow_success_rate", "Workflow success rate"], ["tool_selection_accuracy", "Tool-selection accuracy"],
  ["unsupported_claim_rate", "Unsupported-claim rate"], ["escalation_precision", "Escalation precision"], ["escalation_recall", "Escalation recall"],
  ["error_recovery_rate", "Error recovery rate"], ["retrieval_hit_rate", "Retrieval hit rate"],
];

function rate(v: Rate | number | null | undefined): Rate {
  return (v && typeof v === "object" ? v : { value: null }) as Rate;
}

export default function EvaluationPage() {
  const { status } = useSession();
  const toast = useToast();
  const overview = useApi<Overview>("/evaluations", []);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState("demo");
  const [busy, setBusy] = useState(false);
  const runId = selected ?? overview.data?.runs.find((r) => r.status === "completed")?.id ?? overview.data?.runs[0]?.id ?? null;
  const detail = useApi<RunDetail>(runId ? `/evaluations/runs/${runId}` : null, [runId]);
  const running = overview.data?.runs.some((r) => r.status === "queued" || r.status === "running");

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { void overview.reload(); void detail.reload(); }, 1500);
    return () => clearInterval(t);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>("/evaluations/runs", { mode, systems: ["baseline", "agent"] });
      setSelected(r.id);
      toast("info", "Evaluation started. Each case runs through the real workflow engine.");
      void overview.reload();
    } catch (e) { toast("error", (e as ApiError).message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader
        title="Evaluation"
        description="Compares a retrieval-only assistant with the full agent workflow on the same cases and the same explicit success criteria. All numbers come from recorded runs."
        actions={
          <>
            <Select aria-label="Evaluation mode" value={mode} onChange={(e) => setMode(e.target.value)} className="w-auto">
              <option value="demo">Demo mode (no model calls)</option>
              <option value="live" disabled={!status?.llm_configured}>Live LLM {status?.llm_configured ? "(incurs API cost)" : "(not configured)"}</option>
            </Select>
            <Button variant="primary" icon={<Play className="size-4" aria-hidden />} loading={busy || running} onClick={start}>{running ? "Running…" : "Run evaluation"}</Button>
          </>
        }
      />
      <div className="mb-4">
        <Notice tone="amber" title="How to read these results">
          Demo-mode runs measure the deterministic pipeline on its own designed test cases (dataset {overview.data?.dataset_version}). They show that behaviours work as specified;
          they are not research findings about LLM performance. Unsupported claims are labelled from evidence citations, not by automatically judging truth.
        </Notice>
      </div>
      {overview.error && <Card><ErrorState error={overview.error} onRetry={overview.reload} /></Card>}
      {!overview.data && !overview.error && <Card><LoadingBlock rows={5} /></Card>}
      {overview.data && overview.data.runs.length === 0 && (
        <Card>
          <EmptyState icon={<FlaskConical className="size-5" aria-hidden />} title="No evaluation runs yet"
            body={`Dataset ${overview.data.dataset_version} has ${overview.data.cases.length} cases. Run an evaluation to record baseline and agent results.`}
            action={<Button variant="primary" onClick={start} loading={busy}>Run evaluation</Button>} />
          <ul className="divide-y divide-line border-t border-line">
            {overview.data.cases.map((c) => (
              <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px]">
                <span><span className="font-medium">{c.title}</span> <span className="text-muted">“{c.input}”</span></span>
                <Badge>expected: {label(c.expected.outcome)}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {overview.data && overview.data.runs.length > 0 && (
        <div className="space-y-4">
          <Card>
            <CardHeader title="Runs" />
            <div className="flex flex-wrap gap-2 p-3">
              {overview.data.runs.map((r) => (
                <button key={r.id} type="button" onClick={() => setSelected(r.id)} aria-pressed={r.id === runId}
                  className={cx("rounded-lg border px-3 py-2 text-left text-[12.5px]", r.id === runId ? "border-indigo-400 bg-indigo-50/60" : "border-line hover:bg-slate-50")}>
                  <span className="block font-medium">{fmtDate(r.created_at)} · {r.mode}</span>
                  <span className="block text-muted">{r.status}{r.error ? ` — ${r.error}` : ""}</span>
                </button>
              ))}
            </div>
          </Card>
          {detail.data && <RunView d={detail.data} />}
        </div>
      )}
    </>
  );
}

function RunView({ d }: { d: RunDetail }) {
  const s = d.run.summary ?? {};
  const [system, setSystem] = useState<"all" | "baseline" | "agent">("all");
  if (d.run.status !== "completed") {
    return <Card><div className="p-4">{d.run.status === "failed" ? <Notice tone="red" title="Run failed">{d.run.error}</Notice> : <LoadingBlock rows={3} />}<p className="px-4 pb-2 text-xs text-muted">{d.results.length} case results recorded so far.</p></div></Card>;
  }
  const chart = METRICS.filter(([k]) => k !== "unsupported_claim_rate").map(([k, l]) => ({
    name: l.replace(" rate", "").replace("accuracy", "acc."),
    Baseline: rate(s.baseline?.[k]).value === null ? null : (rate(s.baseline?.[k]).value ?? 0) * 100,
    Agent: rate(s.agent?.[k]).value === null ? null : (rate(s.agent?.[k]).value ?? 0) * 100,
  }));
  const rows = d.results.filter((r) => system === "all" || r.system === system);
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardHeader title="Metric comparison" subtitle="Values with numerator / denominator. “N/A” = the metric does not apply to that system."
            actions={<>
              <a href={`/api/evaluations/runs/${d.run.id}/export?format=csv`}><Button size="sm" icon={<Download className="size-4" aria-hidden />}>CSV</Button></a>
              <a href={`/api/evaluations/runs/${d.run.id}/export?format=json`}><Button size="sm" icon={<Download className="size-4" aria-hidden />}>JSON</Button></a>
            </>} />
          <div className="overflow-x-auto">
            <table className="min-w-full text-[13px]">
              <thead className="bg-slate-50 text-left text-xs text-muted"><tr><th scope="col" className="px-3 py-2 font-medium">Metric</th><th scope="col" className="px-3 py-2 font-medium">Retrieval-only baseline</th><th scope="col" className="px-3 py-2 font-medium">Agent workflow</th></tr></thead>
              <tbody className="divide-y divide-line">
                {METRICS.map(([k, l]) => (
                  <tr key={k}>
                    <th scope="row" className="px-3 py-2 text-left font-medium" title={d.definitions[k]}>{l}<span className="block text-[11px] font-normal text-muted">{d.definitions[k]?.split(".")[0]}</span></th>
                    {(["baseline", "agent"] as const).map((sys) => {
                      const r = rate(s[sys]?.[k]);
                      return <td key={sys} className="px-3 py-2 tabular-nums">{r.not_applicable ? <Badge>N/A</Badge> : r.value === null ? <span className="text-muted">undefined (0 / 0)</span> : <>{fmtPct(r.value)} <span className="text-xs text-muted">({r.numerator}/{r.denominator})</span></>}</td>;
                    })}
                  </tr>
                ))}
                <tr><th scope="row" className="px-3 py-2 text-left font-medium">Avg execution duration</th><td className="px-3 py-2">{fmtMs(s.baseline?.avg_duration_ms as number)}</td><td className="px-3 py-2">{fmtMs(s.agent?.avg_duration_ms as number)}</td></tr>
                <tr><th scope="row" className="px-3 py-2 text-left font-medium">Tokens (in / out)</th><td className="px-3 py-2">{String(s.baseline?.input_tokens ?? 0)} / {String(s.baseline?.output_tokens ?? 0)}</td><td className="px-3 py-2">{String(s.agent?.input_tokens ?? 0)} / {String(s.agent?.output_tokens ?? 0)}</td></tr>
                <tr><th scope="row" className="px-3 py-2 text-left font-medium">Estimated model cost</th><td className="px-3 py-2">${Number(s.baseline?.cost_usd ?? 0).toFixed(4)}</td><td className="px-3 py-2">${Number(s.agent?.cost_usd ?? 0).toFixed(4)}</td></tr>
              </tbody>
            </table>
          </div>
        </Card>
        <Card>
          <CardHeader title="Rates (%)" subtitle={`Run ${d.run.id} · dataset ${d.run.dataset_version} · ${d.run.mode} mode · ${fmtDate(d.run.started_at)} → ${fmtDate(d.run.finished_at)}`} />
          <div className="h-80 px-2 py-3" role="img" aria-label="Bar chart comparing baseline and agent rates; values are in the table">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ left: -10, right: 8, bottom: 30 }}>
                <CartesianGrid vertical={false} stroke="#e3e7ee" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#5b6474" }} interval={0} angle={-25} textAnchor="end" height={50} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "#5b6474" }} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v) => (v === null ? "N/A" : `${Number(v).toFixed(1)}%`)} />
                <Legend wrapperStyle={{ fontSize: 12 }} verticalAlign="top" />
                <Bar dataKey="Baseline" fill="#94a3b8" radius={[3, 3, 0, 0]} />
                <Bar dataKey="Agent" fill="#4f46e5" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="border-t border-line px-4 py-3 text-xs text-muted">
            Model configuration: <span className="font-mono">{JSON.stringify(d.run.model_config?.models ?? d.run.model_config)}</span>
          </div>
        </Card>
      </div>
      <Card className="overflow-hidden">
        <CardHeader title="Case-level results" actions={
          <Select aria-label="System" value={system} onChange={(e) => setSystem(e.target.value as typeof system)} className="w-auto">
            <option value="all">Both systems</option><option value="baseline">Baseline</option><option value="agent">Agent</option>
          </Select>
        } />
        <div className="overflow-x-auto">
          <table className="min-w-full text-[13px]">
            <thead className="bg-slate-50 text-left text-xs text-muted">
              <tr>{["Case", "System", "Expected", "Outcome", "Pass", "Tools called", "Claims (unsupported)", "Duration", ""].map((h) => <th key={h} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => {
                const unsupported = r.claims.filter((c) => c.label === "unsupported");
                return (
                  <tr key={`${r.case_key}-${r.system}`} className="align-top">
                    <td className="px-3 py-2"><span className="font-medium">{r.case_title}</span><span className="block max-w-[16rem] truncate text-[11.5px] text-muted" title={r.input}>“{r.input}”</span></td>
                    <td className="px-3 py-2"><Badge tone={r.system === "agent" ? "indigo" : "slate"}>{r.system}</Badge></td>
                    <td className="whitespace-nowrap px-3 py-2">{label(r.expected.outcome)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{label(r.outcome)}</td>
                    <td className="px-3 py-2">{r.passed ? <Badge tone="green">Pass</Badge> : <Badge tone="red">Fail</Badge>}</td>
                    <td className="max-w-[16rem] px-3 py-2 font-mono text-[11px] text-ink-2">{r.tools_called.join(", ") || "—"}</td>
                    <td className="px-3 py-2">{r.claims.length} ({unsupported.length}){unsupported.length > 0 && <span className="block max-w-[14rem] text-[11px] text-red-700">{unsupported[0].label_reason}</span>}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{fmtMs(r.duration_ms)}</td>
                    <td className="px-3 py-2">{r.workflow_id && <Link href={`/workflows/${r.workflow_id}`} className="text-xs font-medium text-indigo-700 hover:underline">Trace</Link>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
