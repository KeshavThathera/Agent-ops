"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import type { SystemStatus, User } from "./types";

interface SessionValue {
  user: User | null;
  status: SystemStatus | null;
  loading: boolean;
  error: ApiError | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  isStaff: boolean;
  isAdmin: boolean;
}

const Ctx = createContext<SessionValue | null>(null);

async function loadSession(): Promise<{ me: User; st: SystemStatus } | ApiError | null> {
  try {
    const [me, st] = await Promise.all([api.get<User>("/me"), api.get<SystemStatus>("/system/status")]);
    return { me, st };
  } catch (e) {
    return e instanceof ApiError ? e : null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const apply = useCallback((r: { me: User; st: SystemStatus } | ApiError | null) => {
    if (r && "me" in r) {
      setUser(r.me);
      setStatus(r.st);
      setError(null);
    } else {
      setUser(null);
      setError(r);
    }
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => apply(await loadSession()), [apply]);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      // Full reload on purpose: every piece of client state must start fresh for the new identity.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/login");
    }
  }, []);

  useEffect(() => {
    let live = true;
    loadSession().then((r) => live && apply(r));
    return () => { live = false; };
  }, [apply]);

  const value: SessionValue = {
    user,
    status,
    loading,
    error,
    refresh,
    logout,
    isStaff: user?.role === "engineer" || user?.role === "admin",
    isAdmin: user?.role === "admin",
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession must be used inside SessionProvider");
  return v;
}
