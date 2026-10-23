"use client";

import { useState } from "react";
import { Cable, ChevronDown, ChevronRight, Lock, PlugZap, ShieldCheck, Wrench } from "lucide-react";
import { Badge, Button, Card, CardHeader, cx, ErrorState, Json, LoadingBlock, Notice, PageHeader, SimulatedTag, StatusBadge, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { fmtDate, fmtMs, label, RISK_TONE, TOOL_STATUS } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import type { ToolCall } from "@/lib/types";

interface PolicyRow { id: string; action_class: string; description: string; decision: string; default_decision: string; risk_level: string; approver_roles: string[]; reason_required: boolean; editable: boolean }
interface ToolRow {
  name: string; description: string; input_schema: Record<string, unknown>; output_schema: Record<string, unknown>; stage: string;
  action_classes: string[]; policies: Array<{ decision: string; policy_id: string; risk_level: string; approver_roles: string[] }>;
  risk_level: string; required_role: string; execution_mode: string; side_effect: boolean; idempotent: boolean; mcp_exposed: boolean;
  integration: string | null; health: string; recent_call_count: number; recent_error_count: number; avg_ms: number | null; recent_calls: ToolCall[];
}
interface ToolsResp { tools: ToolRow[]; policies: PolicyRow[]; mcp: Record<string, unknown> | null; transport: string }
interface Integrations {
  connectors: Array<{ id: string; name: string; kind: string; status: string; implemented: boolean; config: { note?: string } }>;
  llm: { provider: string; configured: boolean; models: Record<string, string>; refusal_fallback: boolean; note: string };
  retrieval: { backend: string; label: string; vector_chunks: number | string | null };
  mcp: Record<string, unknown>;
}

const HEALTH_TONE: Record<string, "green" | "amber" | "red" | "slate"> = { healthy: "green", degraded: "amber", failing: "red", no_recent_calls: "slate", not_configured: "slate" };
const DECISION_TONE: Record<string, "green" | "amber" | "red"> = { automatic: "green", approval_required: "amber", unavailable: "red" };

export default function ToolsPage() {
  const { isAdmin } = useSession();
  const data = useApi<ToolsResp>("/tools", []);
  const integ = useApi<Integrations>(isAdmin ? "/integrations" : null, [isAdmin]);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <PageHeader title="Tools & integrations" description="The typed tool registry the agent can call. Every call is validated, policy-checked and persisted by the server; unknown tools are blocked." />
      {data.error && <Card><ErrorState error={data.error} onRetry={data.reload} /></Card>}
      {!data.data && !data.error && <Card><LoadingBlock rows={8} /></Card>}
      {data.data && (
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <CardHeader title="Tool registry" subtitle={`${data.data.tools.length} tools · current transport for MCP-exposed tools: ${data.data.transport === "mcp" ? "MCP (stdio)" : "in-process"}`} icon={<Wrench className="size-4" aria-hidden />} />
            <ul className="divide-y divide-line">
              {data.data.tools.map((t) => (
                <li key={t.name}>
                  <button type="button" onClick={() => setOpen(open === t.name ? null : t.name)} aria-expanded={open === t.name}
                    className="flex w-full flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 text-left hover:bg-slate-50/60">
                    <span className="flex min-w-[16rem] flex-1 items-start gap-2">
                      {open === t.name ? <ChevronDown className="mt-0.5 size-4 text-muted" aria-hidden /> : <ChevronRight className="mt-0.5 size-4 text-muted" aria-hidden />}
                      <span>
                        <span className="block font-mono text-[13px] font-medium text-ink">{t.name}</span>
                        <span className="block text-[12.5px] text-muted">{t.description}</span>
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={RISK_TONE[t.risk_level]}>{label(t.risk_level)} risk</Badge>
                      {[...new Set(t.policies.map((p) => p.decision))].map((dec) => <Badge key={dec} tone={DECISION_TONE[dec]}>{label(dec)}</Badge>)}
                      <Badge tone="slate">role: {t.required_role}</Badge>
                      {t.integration ? null : t.execution_mode.startsWith("sandbox") ? <SimulatedTag label="Sandbox" /> : <Badge tone="sky">real app logic</Badge>}
                      {t.mcp_exposed && <Badge tone="violet">MCP</Badge>}
                      <Badge tone={HEALTH_TONE[t.health]}>{t.health === "no_recent_calls" ? "No recent calls" : label(t.health)}</Badge>
                    </span>
                  </button>
                  {open === t.name && (
                    <div className="grid gap-4 border-t border-line bg-slate-50/50 px-4 py-4 lg:grid-cols-2">
                      <div className="space-y-3 text-[13px]">
                        <dl className="grid grid-cols-[9rem_1fr] gap-y-1">
                          <dt className="text-muted">Stage</dt><dd>{label(t.stage)}</dd>
                          <dt className="text-muted">Action classes</dt><dd className="font-mono text-[12px]">{t.action_classes.join(", ")}</dd>
                          <dt className="text-muted">Approval policy</dt><dd>{t.policies.map((p) => `${p.policy_id}: ${label(p.decision)}${p.approver_roles.length ? ` (${p.approver_roles.join("/")})` : ""}`).join("; ")}</dd>
                          <dt className="text-muted">Execution mode</dt><dd>{t.execution_mode}</dd>
                          <dt className="text-muted">Side effects</dt><dd>{t.side_effect ? "Yes" : "No"} · {t.idempotent ? "idempotent" : "not idempotent"}</dd>
                          <dt className="text-muted">Recent calls</dt><dd>{t.recent_call_count} ({t.recent_error_count} errors) · avg {fmtMs(t.avg_ms)}</dd>
                          {t.integration && <><dt className="text-muted">Integration</dt><dd>{t.integration} — not configured</dd></>}
                        </dl>
                        <div>
                          <p className="mb-1 text-xs font-medium text-ink-2">Recent calls</p>
                          {t.recent_calls.length === 0 ? <p className="text-xs text-muted">None recorded.</p> : (
                            <ul className="space-y-1">
                              {t.recent_calls.map((c) => (
                                <li key={c.id} className="flex flex-wrap items-center gap-2 text-xs">
                                  <StatusBadge meta={TOOL_STATUS} value={c.status} /><span className="text-muted">{fmtDate(c.created_at)}</span>
                                  <span>{fmtMs(c.duration_ms)}</span>{c.transport === "mcp" && <Badge tone="violet">MCP</Badge>}
                                  {c.workflow_id && <a className="text-indigo-700 hover:underline" href={`/workflows/${c.workflow_id}`}>workflow</a>}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                      <div className="space-y-3">
                        <div><p className="mb-1 text-xs font-medium text-ink-2">Input schema (strict, extra fields rejected)</p><Json value={t.input_schema} /></div>
                        <div><p className="mb-1 text-xs font-medium text-ink-2">Output schema</p><Json value={t.output_schema} /></div>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <div className="grid gap-4">
            <Card className="overflow-hidden">
              <CardHeader title="Risk policies" subtitle="Evaluated by the server at execution time. Document text and model output cannot change them." icon={<ShieldCheck className="size-4" aria-hidden />} />
              <div className="overflow-x-auto">
                <table className="min-w-full text-[13px]">
                  <thead className="bg-slate-50 text-left text-xs text-muted"><tr>{["Policy", "Action", "Decision", "Risk", "Approvers"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-line">
                    {data.data.policies.map((p) => (
                      <tr key={p.id}>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px]">{p.id}</td>
                        <td className="px-3 py-2">{p.description}</td>
                        <td className="px-3 py-2"><Badge tone={DECISION_TONE[p.decision]}>{label(p.decision)}</Badge>{!p.editable && <Lock className="ml-1 inline size-3 text-slate-400" aria-label="Locked policy" />}</td>
                        <td className="px-3 py-2">{label(p.risk_level)}</td>
                        <td className="px-3 py-2 text-xs">{p.approver_roles.join(", ") || "—"}{p.reason_required && " · reason required"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <McpCard mcp={data.data.mcp} transport={data.data.transport} onProbed={data.reload} />
          </div>

          {isAdmin && integ.data && (
            <Card>
              <CardHeader title="Integrations" subtitle="Connectors show “Not configured” unless implemented and connected. Nothing here is marked connected without a working integration." icon={<Cable className="size-4" aria-hidden />} />
              <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
                <Integration name="LLM provider (Anthropic Claude)" ok={integ.data.llm.configured}
                  status={integ.data.llm.configured ? "Configured (credentials present)" : "Not configured"}
                  note={`Classifier: ${integ.data.llm.models.classifier} · Planner: ${integ.data.llm.models.planner}. ${integ.data.llm.note}`} />
                <Integration name="Retrieval backend" ok status={integ.data.retrieval.backend === "chroma" ? "Vector search active" : "Keyword retrieval active"}
                  note={`${integ.data.retrieval.label}${typeof integ.data.retrieval.vector_chunks === "number" ? ` · ${integ.data.retrieval.vector_chunks} vectors` : ""}`} />
                {integ.data.connectors.map((c) => (
                  <Integration key={c.id} name={c.name} ok={false} status={c.implemented ? label(c.status) : "Not configured"} note={c.config.note ?? ""} />
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

function Integration({ name, ok, status, note }: { name: string; ok: boolean; status: string; note: string }) {
  return (
    <div className={cx("rounded-lg border p-3", ok ? "border-emerald-200 bg-emerald-50/40" : "border-line")}>
      <p className="text-[13px] font-medium">{name}</p>
      <p className="mt-1"><Badge tone={ok ? "green" : "slate"}>{status}</Badge></p>
      <p className="mt-1.5 text-xs text-muted">{note}</p>
    </div>
  );
}

function McpCard({ mcp, transport, onProbed }: { mcp: Record<string, unknown> | null; transport: string; onProbed: () => void }) {
  const { isAdmin } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const probe = async () => {
    setBusy(true);
    try {
      const r = await api.post<Record<string, unknown>>("/tools/mcp/probe");
      toast(r.ok ? "success" : "error", r.ok ? "MCP server connected and answered a tool call" : `MCP probe failed: ${String(r.error)}`);
      onProbed();
    } catch (e) { toast("error", (e as ApiError).message); }
    finally { setBusy(false); }
  };
  const tools = (mcp?.tools as Array<{ name: string }> | undefined) ?? [];
  return (
    <Card>
      <CardHeader title="MCP server" subtitle="app.mcp_server exposes the read-only sandbox tools over stdio; the backend's MCP client calls it."
        icon={<PlugZap className="size-4" aria-hidden />}
        actions={isAdmin && <Button size="sm" loading={busy} onClick={probe}>Test connection</Button>} />
      <div className="space-y-3 px-4 py-3.5 text-[13px]">
        <p>Transport for MCP-exposed tools in workflows: <span className="font-medium">{transport === "mcp" ? "MCP (stdio subprocess per call)" : "in-process"}</span>. Change it in Settings → Demo controls.</p>
        {!mcp ? <Notice>Not probed yet. {isAdmin ? "Use “Test connection” to launch the server, list its tools and make one real call." : "An administrator can run a connection test."}</Notice> : mcp.ok ? (
          <Notice tone="green" title="Last probe succeeded">
            Server {String(mcp.server_name)} {String(mcp.server_version ?? "")} · negotiated protocol version <span className="font-mono">{String(mcp.protocol_version)}</span> · {fmtDate(String(mcp.checked_at))}
            <span className="mt-1 block">Tools: {tools.map((t) => t.name).join(", ")}</span>
          </Notice>
        ) : (
          <Notice tone="red" title="Last probe failed">{String(mcp.error)} · {fmtDate(String(mcp.checked_at))}</Notice>
        )}
      </div>
    </Card>
  );
}
