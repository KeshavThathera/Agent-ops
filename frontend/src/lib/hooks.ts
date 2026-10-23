"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, ApiError } from "./api";
import type { WorkflowDetail, WorkflowEvent } from "./types";

export interface Loadable<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (d: T) => void;
}

/** GET a resource; `deps` re-trigger the fetch when the path itself does not change. */
export function useApi<T>(path: string | null, deps: unknown[] = []): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const seq = useRef(0);
  const depKey = JSON.stringify(deps);

  const fetchOnce = useCallback(async (): Promise<{ ok: true; d: T } | { ok: false; e: ApiError }> => {
    try {
      return { ok: true, d: await api.get<T>(path!) };
    } catch (e) {
      return { ok: false, e: e instanceof ApiError ? e : new ApiError(0, "error", String(e)) };
    }
  }, [path, depKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = useCallback((mine: number, r: { ok: true; d: T } | { ok: false; e: ApiError }) => {
    if (mine !== seq.current) return; // a newer request superseded this one
    if (r.ok) {
      setData(r.d);
      setError(null);
    } else setError(r.e);
    setLoading(false);
  }, []);

  const reload = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    setLoading(true);
    apply(mine, await fetchOnce());
  }, [path, fetchOnce, apply]);

  useEffect(() => {
    if (!path) return;
    const mine = ++seq.current;
    fetchOnce().then((r) => apply(mine, r));
  }, [path, fetchOnce, apply]);

  return { data, error, loading, reload, setData };
}

export type StreamState = "connecting" | "live" | "reconnecting" | "closed";

/**
 * Loads a workflow, then follows its persisted event stream over SSE.
 * EventSource resends Last-Event-ID on reconnect and the server resumes after it, so events are
 * neither lost nor duplicated; we also de-duplicate by id. Each event triggers a debounced refetch
 * of the full persisted state, so the screen always shows what the database says.
 */
export function useWorkflow(workflowId: string | null) {
  const wf = useApi<WorkflowDetail>(workflowId ? `/workflows/${workflowId}` : null, [workflowId]);
  const [stream, setStream] = useState<StreamState>("connecting");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedForThis = wf.data?.workflow.id === workflowId;
  const reloadRef = useRef(wf.reload);
  const initialEvents = useRef<WorkflowEvent[]>([]);

  useEffect(() => {
    reloadRef.current = wf.reload;
    if (wf.data) initialEvents.current = wf.data.events;
  });

  useEffect(() => {
    if (!workflowId || !loadedForThis) return;
    const initial = initialEvents.current;
    const after = initial.length ? initial[initial.length - 1].id : 0;
    const seen = new Set(initial.map((e) => e.id));
    const es = new EventSource(`/api/workflows/${workflowId}/events?after=${after}`);
    es.onopen = () => setStream("live");
    es.onerror = () => setStream(es.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    es.addEventListener("workflow", (msg) => {
      const ev = JSON.parse((msg as MessageEvent).data) as WorkflowEvent;
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void reloadRef.current(), 250);
    });
    return () => {
      es.close();
      if (timer.current) clearTimeout(timer.current);
      setStream("connecting");
    };
  }, [workflowId, loadedForThis]);

  return { ...wf, stream };
}

// ------------------------------------------------------------------ per-viewer UI preferences (localStorage, optional)
const PREF_EVENT = "agentops-pref";

function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // storage unavailable (private mode, blocked): fall back to defaults
  }
}

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(PREF_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(PREF_EVENT, cb);
  };
}

export function useLocalPref<T>(key: string, initial: T): [T, (v: T) => void] {
  const raw = useSyncExternalStore(subscribe, () => readPref(key), () => null);
  let value = initial;
  if (raw !== null) {
    try {
      value = JSON.parse(raw) as T;
    } catch {
      value = initial;
    }
  }
  const set = useCallback(
    (v: T) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* ignore */
      }
      window.dispatchEvent(new Event(PREF_EVENT));
    },
    [key],
  );
  return [value, set];
}
