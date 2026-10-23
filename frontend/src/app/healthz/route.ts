// Liveness endpoint for the hosting platform. Answered by Next.js itself (so the deploy health check does not
// depend on the internal /api proxy) and reports whether the FastAPI backend is reachable.
export const dynamic = "force-dynamic";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";

export async function GET() {
  let backend: string;
  try {
    const r = await fetch(`${BACKEND_URL}/api/health`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    backend = r.ok ? "ok" : `http ${r.status}`;
  } catch (e) {
    backend = `unreachable: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[healthz] backend ${backend}`);
  }
  return Response.json({ status: "ok", web: "ok", backend });
}
