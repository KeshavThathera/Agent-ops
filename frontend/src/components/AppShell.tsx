"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bell, BookOpen, Bot, ChevronsLeft, ChevronsRight, FlaskConical, GraduationCap, LayoutDashboard, LogOut, Menu,
  MessagesSquare, Plus, ScrollText, Settings, ShieldCheck, Ticket, Users, Workflow, Wrench, X,
} from "lucide-react";
import { api } from "@/lib/api";
import { fmtRelative } from "@/lib/format";
import { useLocalPref } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import type { Notification, Role, User } from "@/lib/types";
import { Badge, Button, cx, Spinner } from "./ui";

interface NavItem { href: string; label: string; icon: typeof Bot; roles: Role[]; group: string; badge?: "approvals" }
const ALL: Role[] = ["employee", "engineer", "admin"];
const STAFF: Role[] = ["engineer", "admin"];
const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, roles: STAFF, group: "Operations" },
  { href: "/support", label: "Support Workspace", icon: MessagesSquare, roles: ALL, group: "Operations" },
  { href: "/tickets", label: "Tickets", icon: Ticket, roles: ALL, group: "Operations" },
  { href: "/workflows", label: "Workflows", icon: Workflow, roles: ALL, group: "Operations" },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck, roles: STAFF, group: "Operations", badge: "approvals" },
  { href: "/knowledge", label: "Knowledge Base", icon: BookOpen, roles: ALL, group: "Knowledge & tools" },
  { href: "/tools", label: "Tools & Integrations", icon: Wrench, roles: STAFF, group: "Knowledge & tools" },
  { href: "/evaluation", label: "Evaluation", icon: FlaskConical, roles: ["admin"], group: "Governance" },
  { href: "/audit", label: "Audit Log", icon: ScrollText, roles: ["admin"], group: "Governance" },
  { href: "/settings", label: "Settings", icon: Settings, roles: ALL, group: "System" },
  { href: "/about", label: "About Project", icon: GraduationCap, roles: ALL, group: "System" },
];

const TITLES: Array<[RegExp, string]> = [
  [/^\/$/, "Dashboard"], [/^\/support/, "Support Workspace"], [/^\/tickets\/.+/, "Ticket"], [/^\/tickets/, "Tickets"],
  [/^\/workflows\/.+/, "Workflow Execution"], [/^\/workflows/, "Workflows"], [/^\/approvals/, "Human Approval Queue"],
  [/^\/knowledge\/.+/, "Knowledge Article"], [/^\/knowledge/, "Knowledge Base"], [/^\/tools/, "Tools & Integrations"],
  [/^\/evaluation/, "Evaluation"], [/^\/audit/, "Audit Log"], [/^\/settings/, "Settings"], [/^\/about/, "About Project"],
];

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, status, loading, error } = useSession();
  const path = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useLocalPref("agentops.sidebar.collapsed", false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const staff = user?.role === "engineer" || user?.role === "admin";

  useEffect(() => {
    if (!loading && !user && (!error || error.status === 401)) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [loading, user, error, router, path]);

  useEffect(() => setMobileOpen(false), [path]);

  useEffect(() => {
    if (!staff) return;
    let live = true;
    const load = () => api.get<unknown[]>("/approvals?status=pending").then((a) => live && setPending(a.length)).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => { live = false; clearInterval(t); };
  }, [staff, path]);

  if (loading || (!user && !error)) {
    return <div className="grid min-h-screen place-items-center"><Spinner label="Loading AgentOps Desk" /></div>;
  }
  if (!user) {
    return (
      <div className="grid min-h-screen place-items-center p-6 text-center">
        <div>
          <p className="font-medium">Cannot reach the AgentOps Desk API.</p>
          <p className="mt-1 text-sm text-muted">{error?.message}</p>
          <p className="mt-1 text-sm text-muted">Start the backend (see README) and reload.</p>
        </div>
      </div>
    );
  }

  const items = NAV.filter((n) => n.roles.includes(user.role));
  const groups = [...new Set(items.map((i) => i.group))];
  const title = TITLES.find(([re]) => re.test(path))?.[1] ?? "AgentOps Desk";

  const nav = (compact: boolean) => (
    <nav aria-label="Primary" className="flex-1 overflow-y-auto px-2 py-3 scrollbar-thin">
      {groups.map((g) => (
        <div key={g} className="mb-4">
          {!compact && <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-navy-300/70">{g}</p>}
          <ul className="space-y-0.5">
            {items.filter((i) => i.group === g).map((i) => {
              const active = isActive(path, i.href);
              const Icon = i.icon;
              return (
                <li key={i.href}>
                  <Link
                    href={i.href}
                    title={compact ? i.label : undefined}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors",
                      active ? "bg-white/10 text-white" : "text-navy-200 hover:bg-white/5 hover:text-white",
                      compact && "justify-center",
                    )}
                  >
                    <Icon className={cx("size-[18px] shrink-0", active ? "text-indigo-300" : "text-navy-300")} aria-hidden />
                    {!compact && <span className="flex-1 truncate">{i.label === "Tickets" && user.role === "employee" ? "My Tickets" : i.label}</span>}
                    {!compact && i.badge === "approvals" && !!pending && (
                      <span className="rounded-full bg-amber-400 px-1.5 text-[11px] font-semibold text-navy-950" aria-label={`${pending} pending`}>{pending}</span>
                    )}
                    {compact && i.badge === "approvals" && !!pending && <span className="sr-only">{pending} pending</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  const brand = (compact: boolean) => (
    <div className={cx("flex h-14 items-center gap-2.5 border-b border-white/10 px-4", compact && "justify-center px-0")}>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-indigo-500/90 text-white"><Bot className="size-[18px]" aria-hidden /></span>
      {!compact && (
        <div className="min-w-0 leading-tight">
          <p className="truncate text-[14px] font-semibold text-white">AgentOps Desk</p>
          <p className="truncate text-[11px] text-navy-300">IT Operations & Support</p>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only z-50 rounded bg-white px-3 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to content</a>

      {/* desktop sidebar */}
      <aside className={cx("sticky top-0 hidden h-screen shrink-0 flex-col bg-navy-900 transition-[width] duration-200 lg:flex", collapsed ? "w-[68px]" : "w-64")}>
        {brand(collapsed)}
        {nav(collapsed)}
        <div className="border-t border-white/10 p-2">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cx("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-navy-300 hover:bg-white/5 hover:text-white", collapsed && "justify-center")}
          >
            {collapsed ? <ChevronsRight className="size-4" aria-hidden /> : <><ChevronsLeft className="size-4" aria-hidden />Collapse</>}
          </button>
        </div>
      </aside>

      {/* mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button type="button" className="absolute inset-0 bg-navy-950/50" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col bg-navy-900 shadow-xl animate-fade-in">
            <div className="flex items-center justify-between pr-2">
              {brand(false)}
              <button type="button" onClick={() => setMobileOpen(false)} className="rounded-md p-2 text-navy-200 hover:bg-white/10" aria-label="Close navigation">
                <X className="size-5" aria-hidden />
              </button>
            </div>
            {nav(false)}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-white/90 px-3 backdrop-blur sm:gap-3 sm:px-5">
          <button type="button" onClick={() => setMobileOpen(true)} className="rounded-md p-2 text-ink-2 hover:bg-slate-100 lg:hidden" aria-label="Open navigation">
            <Menu className="size-5" aria-hidden />
          </button>
          <p className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{title}</p>
          <EnvBadge llm={!!status?.llm_configured} />
          <Link href="/support?new=1" className="hidden sm:block">
            <Button variant="primary" size="sm" icon={<Plus className="size-4" aria-hidden />}>New request</Button>
          </Link>
          <NotificationBell />
          <UserMenu user={user} demo={!!status?.demo_accounts_enabled} />
        </header>
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900 sm:hidden">
          {status?.llm_configured ? "Live LLM · sandbox IT tools" : "Demo mode — simulated AI and IT tools"}
        </div>
        <main id="main" className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-6">{children}</main>
      </div>
    </div>
  );
}

function EnvBadge({ llm }: { llm: boolean }) {
  return (
    <span
      className="hidden items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900 ring-1 ring-inset ring-amber-300 sm:inline-flex"
      title={llm
        ? "A hosted LLM is configured for live runs. All IT diagnostics and remediations still run against the sandbox — never a real device."
        : "No LLM credentials configured. Classification and planning use a deterministic demo planner; IT diagnostics and remediations are simulated in a sandbox."}
    >
      <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
      {llm ? "Live LLM · sandbox IT tools" : "Demo mode — simulated AI and IT tools"}
    </span>
  );
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return { open, setOpen, ref };
}

function NotificationBell() {
  const { open, setOpen, ref } = usePopover();
  const [data, setData] = useState<{ items: Notification[]; unread: number } | null>(null);
  const load = () => api.get<{ items: Notification[]; unread: number }>("/notifications").then(setData).catch(() => {});
  useEffect(() => {
    void load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  const markAll = async () => { await api.post("/notifications/read", {}); void load(); };
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => { setOpen(!open); if (!open) void load(); }} aria-expanded={open} aria-haspopup="true"
        aria-label={`Notifications${data?.unread ? `, ${data.unread} unread` : ""}`}
        className="relative rounded-lg p-2 text-ink-2 hover:bg-slate-100">
        <Bell className="size-5" aria-hidden />
        {!!data?.unread && <span className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">{data.unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-line bg-white shadow-xl animate-fade-in">
          <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <p className="text-sm font-semibold">Notifications</p>
            {!!data?.unread && <button type="button" onClick={markAll} className="text-xs font-medium text-indigo-700 hover:underline">Mark all read</button>}
          </div>
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {!data?.items.length && <li className="px-4 py-8 text-center text-[13px] text-muted">No notifications yet.</li>}
            {data?.items.map((n) => (
              <li key={n.id}>
                <Link href={n.link ?? "#"} onClick={() => { setOpen(false); void api.post("/notifications/read", { ids: [n.id] }).then(load); }}
                  className={cx("block px-3.5 py-2.5 hover:bg-slate-50", !n.read && "bg-indigo-50/40")}>
                  <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                    {!n.read && <span className="size-1.5 rounded-full bg-indigo-600" aria-label="Unread" />}{n.title}
                  </p>
                  {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{n.body}</p>}
                  <p className="mt-1 text-[11px] text-slate-400">{fmtRelative(n.created_at)}</p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function UserMenu({ user, demo }: { user: User; demo: boolean }) {
  const { open, setOpen, ref } = usePopover();
  const { logout } = useSession();
  const [demoUsers, setDemoUsers] = useState<User[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);
  useEffect(() => {
    if (open && demo && !demoUsers.length) api.get<{ demo_users: User[] }>("/auth/config").then((c) => setDemoUsers(c.demo_users)).catch(() => {});
  }, [open, demo, demoUsers.length]);
  const switchTo = async (email: string) => {
    setSwitching(email);
    try {
      await api.post("/auth/demo-login", { email });
      // Full reload on purpose: every piece of client state must start fresh for the new identity.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/");
    } finally {
      setSwitching(null);
    }
  };
  const initials = user.name.split(" ").map((p) => p[0]).slice(0, 2).join("");
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true" aria-label={`Account menu for ${user.name}`}
        className="flex items-center gap-2 rounded-lg p-1 pr-1.5 hover:bg-slate-100">
        <span className="grid size-8 place-items-center rounded-full bg-navy-800 text-xs font-semibold text-white">{initials}</span>
        <span className="hidden text-left leading-tight md:block">
          <span className="block text-[13px] font-medium text-ink">{user.name}</span>
          <span className="block text-[11px] capitalize text-muted">{user.role === "engineer" ? "Support engineer" : user.role}</span>
        </span>
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-72 overflow-hidden rounded-xl border border-line bg-white shadow-xl animate-fade-in">
          <div className="border-b border-line px-3.5 py-3">
            <p className="text-sm font-semibold">{user.name}</p>
            <p className="text-xs text-muted">{user.email}</p>
            <p className="mt-1.5"><Badge tone="indigo">{user.role === "engineer" ? "Support engineer" : user.role === "admin" ? "Administrator" : "Employee"}</Badge></p>
          </div>
          {demo && (
            <div className="border-b border-line px-3.5 py-3">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-ink-2"><Users className="size-3.5" aria-hidden />Switch demo account</p>
              <p className="mb-2 text-[11px] leading-snug text-muted">Illustrative role switching for the demo environment. Each switch is a real server-side sign-in; it is not a production security feature.</p>
              <ul className="space-y-0.5">
                {demoUsers.filter((u) => u.id !== user.id).map((u) => (
                  <li key={u.id}>
                    <button type="button" onClick={() => switchTo(u.email)} disabled={!!switching}
                      className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-slate-50 disabled:opacity-60">
                      <span>{u.name}</span><span className="text-[11px] capitalize text-muted">{switching === u.email ? "Switching…" : u.role}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="p-1.5">
            <Link href="/settings" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] hover:bg-slate-50">
              <Settings className="size-4 text-muted" aria-hidden />Settings
            </Link>
            <button type="button" onClick={logout} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-red-700 hover:bg-red-50">
              <LogOut className="size-4" aria-hidden />Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
