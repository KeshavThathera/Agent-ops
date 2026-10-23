import {
  AlertTriangle, Ban, CheckCircle2, CircleDashed, CircleDot, Clock3, Hand, Loader2, MessageCircleQuestion, OctagonX,
  ShieldAlert, ShieldX, UserRoundCog, XCircle, ArrowUpRight, type LucideIcon,
} from "lucide-react";

export type Tone = "indigo" | "green" | "amber" | "red" | "slate" | "violet" | "sky";

export const TONE_CLASSES: Record<Tone, string> = {
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
  sky: "bg-sky-50 text-sky-700 ring-sky-200",
};

interface StatusMeta {
  label: string;
  tone: Tone;
  icon: LucideIcon;
  spin?: boolean;
}

const RUNNING = (label: string): StatusMeta => ({ label, tone: "indigo", icon: Loader2, spin: true });

export const WORKFLOW_STATUS: Record<string, StatusMeta> = {
  received: RUNNING("Received"),
  classifying: RUNNING("Classifying"),
  retrieving: RUNNING("Retrieving"),
  planning: RUNNING("Planning"),
  diagnosing: RUNNING("Diagnosing"),
  executing: RUNNING("Executing"),
  verifying: RUNNING("Verifying"),
  awaiting_approval: { label: "Awaiting approval", tone: "amber", icon: ShieldAlert },
  awaiting_user_input: { label: "Awaiting user input", tone: "amber", icon: MessageCircleQuestion },
  awaiting_human_review: { label: "Human review", tone: "amber", icon: UserRoundCog },
  completed: { label: "Completed", tone: "green", icon: CheckCircle2 },
  escalated: { label: "Escalated", tone: "violet", icon: ArrowUpRight },
  failed: { label: "Failed", tone: "red", icon: XCircle },
  cancelled: { label: "Cancelled", tone: "slate", icon: Ban },
  blocked: { label: "Blocked by policy", tone: "red", icon: ShieldX },
};

export const TICKET_STATUS: Record<string, StatusMeta> = {
  open: { label: "Open", tone: "sky", icon: CircleDot },
  in_progress: { label: "In progress", tone: "indigo", icon: CircleDashed },
  waiting_on_user: { label: "Waiting on user", tone: "amber", icon: MessageCircleQuestion },
  pending_approval: { label: "Pending approval", tone: "amber", icon: ShieldAlert },
  escalated: { label: "Escalated", tone: "violet", icon: ArrowUpRight },
  resolved: { label: "Resolved", tone: "green", icon: CheckCircle2 },
  closed: { label: "Closed", tone: "slate", icon: OctagonX },
  cancelled: { label: "Cancelled", tone: "slate", icon: Ban },
};

export const APPROVAL_STATUS: Record<string, StatusMeta> = {
  pending: { label: "Pending", tone: "amber", icon: Clock3 },
  approved: { label: "Approved", tone: "green", icon: CheckCircle2 },
  executing: RUNNING("Executing"),
  executed: { label: "Executed", tone: "green", icon: CheckCircle2 },
  rejected: { label: "Rejected", tone: "red", icon: XCircle },
  info_requested: { label: "Info requested", tone: "amber", icon: MessageCircleQuestion },
  invalidated: { label: "Invalidated", tone: "slate", icon: Ban },
  cancelled: { label: "Cancelled", tone: "slate", icon: Ban },
};

export const STEP_STATUS: Record<string, StatusMeta> = {
  pending: { label: "Pending", tone: "slate", icon: CircleDashed },
  running: RUNNING("Running"),
  done: { label: "Done", tone: "green", icon: CheckCircle2 },
  failed: { label: "Failed", tone: "red", icon: XCircle },
  skipped: { label: "Skipped", tone: "slate", icon: Ban },
  awaiting_approval: { label: "Awaiting approval", tone: "amber", icon: Hand },
  blocked: { label: "Blocked", tone: "red", icon: ShieldX },
};

export const TOOL_STATUS: Record<string, StatusMeta> = {
  success: { label: "Success", tone: "green", icon: CheckCircle2 },
  error: { label: "Error", tone: "red", icon: XCircle },
  timeout: { label: "Timeout", tone: "red", icon: Clock3 },
  blocked: { label: "Blocked", tone: "red", icon: ShieldX },
  needs_approval: { label: "Needs approval", tone: "amber", icon: ShieldAlert },
  running: RUNNING("Running"),
  interrupted: { label: "Interrupted", tone: "amber", icon: AlertTriangle },
};

export const RISK_TONE: Record<string, Tone> = { low: "slate", medium: "amber", high: "red", critical: "red" };
export const PRIORITY_TONE: Record<string, Tone> = { low: "slate", medium: "sky", high: "amber", critical: "red" };

export const CATEGORY_LABEL: Record<string, string> = {
  vpn: "VPN", wifi: "Wi-Fi", account: "Account", email: "Email", printer: "Printer", performance: "Performance",
  unclassified: "Unclassified", security_policy: "Security policy", other: "Other",
};

export function label(s: string | null | undefined): string {
  if (!s) return "—";
  return CATEGORY_LABEL[s] ?? s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function fmtDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return withTime
    ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  return fmtDate(iso, false);
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

export function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${(v * 100).toFixed(v === 1 || v === 0 ? 0 : 1)}%`;
}

export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 4)}…${id.slice(-6)}` : id;
}
