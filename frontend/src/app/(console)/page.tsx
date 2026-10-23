"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Activity, AlertTriangle, BadgeCheck, Clock3, Info, Plus, ShieldAlert, Ticket, Workflow, ArrowUpRight } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader, SimulatedTag, cx } from "@/components/ui";
import { fmtMs, fmtRelative, label, TICKET_STATUS } from "@/lib/format";
import { useApi, useLocalPref } from "@/lib/hooks";
import { useSession } from "@/lib/session";

interface Dashboard {
  origin: string;
  counts: {
    total_tickets: number; active_workflows: number; pending_approvals: number; verified_resolutions: number;
    escalated_cases: number; total_workflows: number; avg_execution_ms: number | null; finished_workflows: number;
  };
  ticket_status: Array<{ status: string; count: number }>;
  category: Array<{ category: string; count: number }>;
  tool_health: Array<{ tool: string; calls: number; errors: number; blocked: number; avg_ms: number; error_rate: number; health: string; last_error: string | null }>;
  recent_failures: Array<{ id: string; tool: string; status: string; error: string | null; workflow_id: string | null; created_at: string }>;
  recent_activity: Array<{ id: number; workflow_id: string; type: string; summary: string; simulated: boolean; created_at: string; request: string | null }>;
  definitions: Record<string, string>;
}

const ORIGINS = [
  { id: "live", label: "Live runs" },
  { id: "seed", label: "Seeded demo data" },
  { id: "eval", label: "Evaluation runs" },
  { id: "all", label: "All" },
];

const STATUS_COLORS: Record<string, string> = {
  resolved: "#059669", escalated: "#7c3aed", pending_approval: "#d97706", waiting_on_user: "#f59e0b", in_progress: "#4f46e5",
  open: "#0284c7", closed: "#64748b", cancelled: "#94a3b8",
};

export default function DashboardPage() {
  const { user, isStaff } = useSession();
  const router = useRouter();
  const [origin, setOrigin] = useLocalPref("agentops.dashboard.origin", "seed");
  const dash = useApi<Dashboard>(isStaff ? `/dashboard?origin=${origin}` : null, [origin]);

  useEffect(() => {
    if (user && !isStaff) router.replace("/support");
  }, [user, isStaff, router]);
  useEffect(() => {
    if (!isStaff) return;
    const t = setInterval(() => void dash.reload(), 10000);
    return () => clearInterval(t);
  }, [isStaff, dash.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isStaff) return null;
  const d = dash.data;
  const c = d?.counts;
  const tiles = c ? [
    { k: "total_tickets", label: "Total tickets", value: c.total_tickets, icon: Ticket, tone: "text-sky-600 bg-sky-50", href: "/tickets" },
    { k: "active_workflows", label: "Active workflows", value: c.active_workflows, icon: Workflow, tone: "text-indigo-600 bg-indigo-50", href: "/workflows" },
    { k: "pending_approvals", label: "Pending approvals", value: c.pending_approvals, icon: ShieldAlert, tone: "text-amber-700 bg-amber-50", href: "/approvals" },
    { k: "verified_resolutions", label: "Verified resolutions", value: c.verified_resolutions, icon: BadgeCheck, tone: "text-emerald-600 bg-emerald-50", href: "/workflows" },
    { k: "escalated_cases", label: "Escalated / in review", value: c.escalated_cases, icon: ArrowUpRight, tone: "text-violet-600 bg-violet-50", href: "/workflows" },
    { k: "avg_execution_ms", label: "Avg execution time", value: fmtMs(c.avg_execution_ms), icon: Clock3, tone: "text-slate-600 bg-slate-100", sub: `${c.finished_workflows} finished` },
  ] : [];

  return (
    <>
      <PageHeader
        title="Operations dashboard"
        description="Every number is computed from stored tickets, workflows and tool calls. Seeded demo data, evaluation runs and live runs are counted separately."
        actions={<Link href="/support?new=1"><Button variant="primary" icon={<Plus className="size-4" aria-hidden />}>New Support Request</Button></Link>}
      />
      <div role="radiogroup" aria-label="Data source" className="mb-4 inline-flex flex-wrap rounded-lg border border-line bg-white p-0.5 shadow-sm">
        {ORIGINS.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={origin === o.id} onClick={() => setOrigin(o.id)}
            className={cx("rounded-md px-3 py-1.5 text-[13px] font-medium", origin === o.id ? "bg-navy-900 text-white" : "text-ink-2 hover:bg-slate-50")}>
            {o.label}
          </button>
        ))}
      </div>

      {dash.error && <Card><ErrorState error={dash.error} onRetry={dash.reload} /></Card>}
      {!d && !dash.error && <Card><LoadingBlock rows={4} /></Card>}

      {d && c && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {tiles.map((t) => {
              const body = (
                <Card className="h-full p-4 transition-colors hover:border-indigo-200">
                  <div className="flex items-start justify-between gap-2">
                    <span className={cx("grid size-8 place-items-center rounded-lg", t.tone)}><t.icon className="size-4" aria-hidden /></span>
                    {d.definitions[t.k] && <span title={d.definitions[t.k]} className="text-slate-400"><Info className="size-3.5" aria-label={d.definitions[t.k]} /></span>}
                  </div>
                  <p className="mt-3 text-2xl font-semibold tabular-nums text-ink">{t.value}</p>
                  <p className="mt-0.5 text-[13px] text-muted">{t.label}</p>
                  {"sub" in t && t.sub && <p className="text-[11.5px] text-slate-400">{t.sub}</p>}
                </Card>
              );
              return "href" in t && t.href ? <Link key={t.k} href={t.href} className="block rounded-xl">{body}</Link> : <div key={t.k}>{body}</div>;
            })}
          </div>

          {c.total_workflows === 0 ? (
            <Card>
              <EmptyState
                title={origin === "live" ? "No live runs yet" : "No records for this source"}
                body={origin === "live" ? "Submit a support request to create the first measured run, or switch to Seeded demo data." : "Choose another data source above."}
                action={<Link href="/support?new=1"><Button variant="primary">New Support Request</Button></Link>}
              />
            </Card>
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader title="Ticket status distribution" subtitle={`${c.total_tickets} tickets`} />
                  <div className="h-64 px-2 py-3" role="img" aria-label={`Ticket status: ${d.ticket_status.map((s) => `${label(s.status)} ${s.count}`).join(", ")}`}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={d.ticket_status.map((s) => ({ ...s, name: TICKET_STATUS[s.status]?.label ?? s.status }))} layout="vertical" margin={{ left: 16, right: 16 }}>
                        <CartesianGrid horizontal={false} stroke="#e3e7ee" />
                        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: "#5b6474" }} />
                        <YAxis type="category" dataKey="name" width={118} tick={{ fontSize: 12, fill: "#374151" }} />
                        <Tooltip cursor={{ fill: "#f1f5f9" }} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                        <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={18}>
                          {d.ticket_status.map((s) => <Cell key={s.status} fill={STATUS_COLORS[s.status] ?? "#64748b"} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
                <Card>
                  <CardHeader title="Recent workflow activity" subtitle="Latest persisted engine events" icon={<Activity className="size-4" aria-hidden />} />
                  <ul className="max-h-64 divide-y divide-line overflow-y-auto">
                    {d.recent_activity.map((e) => (
                      <li key={e.id}>
                        <Link href={`/workflows/${e.workflow_id}`} className="block px-4 py-2 hover:bg-slate-50">
                          <p className="flex items-center gap-2 text-[13px] text-ink"><span className="truncate">{e.summary}</span>{e.simulated && <SimulatedTag />}</p>
                          <p className="truncate text-[11.5px] text-muted">{fmtRelative(e.created_at)} · “{e.request}”</p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>

              <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <Card className="overflow-hidden">
                  <CardHeader title="Tool health" subtitle="Last 24 hours, for workflows in this data source" />
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-[13px]">
                      <thead className="bg-slate-50 text-left text-xs text-muted">
                        <tr>{["Tool", "Calls", "Errors", "Blocked", "Avg", "Health"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}</tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {d.tool_health.map((t) => (
                          <tr key={t.tool}>
                            <td className="px-3 py-2 font-mono text-[12px]">{t.tool}</td>
                            <td className="px-3 py-2 tabular-nums">{t.calls}</td>
                            <td className="px-3 py-2 tabular-nums">{t.errors}</td>
                            <td className="px-3 py-2 tabular-nums">{t.blocked}</td>
                            <td className="px-3 py-2 tabular-nums">{fmtMs(t.avg_ms)}</td>
                            <td className="px-3 py-2"><Badge tone={t.health === "healthy" ? "green" : t.health === "degraded" ? "amber" : "red"}>{label(t.health)}</Badge></td>
                          </tr>
                        ))}
                        {!d.tool_health.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-muted">No tool calls in the last 24 hours.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </Card>
                <Card>
                  <CardHeader title="Recent failures" subtitle="Errors, timeouts and policy blocks" icon={<AlertTriangle className="size-4" aria-hidden />} />
                  {d.recent_failures.length === 0 ? <EmptyState title="No recent failures" /> : (
                    <ul className="divide-y divide-line">
                      {d.recent_failures.map((f) => (
                        <li key={f.id} className="px-4 py-2.5">
                          <Link href={f.workflow_id ? `/workflows/${f.workflow_id}` : "#"} className="block hover:underline">
                            <p className="flex items-center gap-2 text-[13px]"><Badge tone="red">{f.status}</Badge><span className="font-mono text-[12px]">{f.tool}</span></p>
                            <p className="mt-0.5 line-clamp-2 text-xs text-muted">{f.error}</p>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
