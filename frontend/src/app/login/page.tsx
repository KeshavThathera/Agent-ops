"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Bot, KeyRound, ShieldCheck, Users } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { User } from "@/lib/types";
import { Button, Field, Input, Notice } from "@/components/ui";

interface AuthConfig { demo_accounts_enabled: boolean; demo_users: User[]; demo_password_hint: string | null; app_env: string }

const ROLE_LABEL: Record<string, string> = { employee: "Employee", engineer: "Support engineer", admin: "Administrator" };
const ROLE_HINT: Record<string, string> = {
  employee: "Submit requests, answer questions, confirm fixes",
  engineer: "Review diagnostics, approve or reject actions, escalate",
  admin: "Dashboards, knowledge, policies, audit, evaluation",
};

function nextPath(): string {
  if (typeof window === "undefined") return "/";
  const n = new URLSearchParams(window.location.search).get("next");
  return n && n.startsWith("/") && !n.startsWith("//") ? n : "/";
}

export default function LoginPage() {
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    api.get<AuthConfig>("/auth/config").then(setCfg).catch((e: ApiError) => setCfgError(e.message));
    const id = setTimeout(() => setExpired(new URLSearchParams(window.location.search).get("expired") === "1"), 0);
    return () => clearTimeout(id);
  }, []);

  const go = (u: User) => window.location.assign(u.role === "employee" && nextPath() === "/" ? "/support" : nextPath());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy("form");
    try {
      go(await api.post<User>("/auth/login", { email, password }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed");
    } finally {
      setBusy(null);
    }
  };

  const demoLogin = async (u: User) => {
    setBusy(u.email);
    setError(null);
    try {
      go(await api.post<User>("/auth/demo-login", { email: u.email }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed");
      setBusy(null);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_minmax(0,560px)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-navy-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-indigo-500"><Bot className="size-5" aria-hidden /></span>
          <div>
            <p className="text-lg font-semibold">AgentOps Desk</p>
            <p className="text-sm text-navy-300">Agentic AI IT Operations & Support Platform</p>
          </div>
        </div>
        <div className="max-w-lg space-y-5">
          <p className="text-2xl font-semibold leading-snug">Support requests that diagnose, act within policy, and prove the fix before closing.</p>
          <ul className="space-y-3 text-[14px] text-navy-200">
            <li className="flex gap-2.5"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-300" aria-hidden />Sensitive actions pause for human approval bound to exact parameters.</li>
            <li className="flex gap-2.5"><KeyRound className="mt-0.5 size-4 shrink-0 text-emerald-300" aria-hidden />Policy is enforced by the server at execution time, never by the model.</li>
            <li className="flex gap-2.5"><Users className="mt-0.5 size-4 shrink-0 text-emerald-300" aria-hidden />Every step, tool call and decision is persisted and auditable.</li>
          </ul>
        </div>
        <p className="text-xs text-navy-300">Final-year project prototype · IT diagnostics run against a sandbox, never a real device.</p>
      </aside>

      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="grid size-10 place-items-center rounded-xl bg-navy-900 text-white"><Bot className="size-5" aria-hidden /></span>
            <div>
              <p className="text-lg font-semibold">AgentOps Desk</p>
              <p className="text-sm text-muted">Agentic AI IT Operations & Support Platform</p>
            </div>
          </div>
          <h1 className="text-xl font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-muted">Use your AgentOps Desk account.</p>

          {expired && !error && (
            <div className="mt-4">
              <Notice tone="amber" title="Your session ended">
                Please sign in again. On the hosted demo this also happens whenever the server restarts and the demo data is reset.
              </Notice>
            </div>
          )}
          {cfgError && <div className="mt-4"><Notice tone="red" title="API unavailable">{cfgError}</Notice></div>}
          {error && <div className="mt-4"><Notice tone="red" title="Could not sign in">{error}</Notice></div>}

          <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
            <Field label="Email" htmlFor="email">
              <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Button type="submit" variant="primary" className="w-full" loading={busy === "form"} disabled={!email || !password}>Sign in</Button>
          </form>

          {cfg?.demo_accounts_enabled && (
            <section className="mt-8 rounded-xl border border-dashed border-amber-300 bg-amber-50/60 p-4" aria-labelledby="demo-accounts">
              <h2 id="demo-accounts" className="text-sm font-semibold text-amber-900">Demo accounts</h2>
              <p className="mt-1 text-xs leading-relaxed text-amber-900/80">
                Enabled because this server runs with <code className="font-mono">DEMO_ACCOUNTS_ENABLED=true</code>. One-click sign-in is an
                illustrative role switcher for the viva; it is not a production authentication flow. Password for all demo accounts:{" "}
                <code className="font-mono">{cfg.demo_password_hint}</code>
              </p>
              <ul className="mt-3 space-y-1.5">
                {cfg.demo_users.map((u) => (
                  <li key={u.id}>
                    <button type="button" onClick={() => demoLogin(u)} disabled={!!busy}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-amber-200 bg-white px-3 py-2 text-left hover:border-indigo-300 hover:bg-indigo-50/40 disabled:opacity-60">
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-ink">{u.name} <span className="font-normal text-muted">· {ROLE_LABEL[u.role]}</span></span>
                        <span className="block truncate text-[11.5px] text-muted">{ROLE_HINT[u.role]}</span>
                      </span>
                      <span className="shrink-0 text-xs font-medium text-indigo-700">{busy === u.email ? "Signing in…" : "Sign in"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
