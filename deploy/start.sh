#!/usr/bin/env bash
# Container entrypoint: migrate + seed (idempotent), then run FastAPI internally and Next.js publicly.
# If either process exits, the container exits so the platform restarts it.
set -euo pipefail

cd /app/backend
python -m app.cli init

python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --proxy-headers --forwarded-allow-ips="127.0.0.1" &
api=$!

cd /app/web
HOSTNAME=0.0.0.0 PORT="${PORT:-10000}" node server.js &
web=$!

trap 'kill -TERM $api $web 2>/dev/null' TERM INT
wait -n $api $web
status=$?
kill -TERM $api $web 2>/dev/null || true
exit $status
