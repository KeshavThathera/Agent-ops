#!/usr/bin/env bash
# Container entrypoint: migrate + seed (idempotent), then run FastAPI internally and Next.js publicly.
# If either process exits, the container exits so the platform restarts it.
set -euo pipefail

PORT="${PORT:-10000}"
cd /app/backend
python -m app.cli init

python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --proxy-headers --forwarded-allow-ips="127.0.0.1" &
api=$!

# Wait until the API answers before exposing the web server.
python - <<'PY'
import time, urllib.request
for i in range(60):
    try:
        with urllib.request.urlopen("http://127.0.0.1:8000/api/health", timeout=2) as r:
            print(f"start.sh: backend ready (HTTP {r.status})", flush=True)
            break
    except Exception as exc:
        time.sleep(1)
else:
    print("start.sh: backend did not become ready in 60s", flush=True)
PY

cd /app/web
HOSTNAME=0.0.0.0 PORT="$PORT" node server.js &
web=$!

# One-off self-test through the public port, so the deploy log shows whether the /api proxy works.
python - <<PY &
import time, urllib.request
time.sleep(3)
for path in ("/healthz", "/login", "/api/health"):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:${PORT}{path}", timeout=10) as r:
            print(f"start.sh: self-test {path} -> HTTP {r.status}", flush=True)
    except Exception as exc:
        print(f"start.sh: self-test {path} FAILED: {exc!r}", flush=True)
PY

trap 'kill -TERM $api $web 2>/dev/null' TERM INT
wait -n $api $web
status=$?
kill -TERM $api $web 2>/dev/null || true
exit $status
