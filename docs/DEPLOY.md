# Deploying to Render (free tier)

The repository contains a single-container production setup:

- `Dockerfile` (repo root) — builds the Next.js standalone server, then a Python 3.13 image that also carries the
  Node binary. FastAPI listens on `127.0.0.1:8000` inside the container; Next.js listens on `$PORT` and proxies
  `/api/*` to it, so the browser sees one origin (secure cookies, SSE, no CORS).
- `deploy/start.sh` — runs `python -m app.cli init` (migrations + idempotent seed), then both servers; if either
  exits, the container exits and Render restarts it.
- `render.yaml` — Render Blueprint for one free Docker web service with health check `/api/health`.

## Steps

1. Push this folder to a GitHub repository (private is fine).
2. Sign in at https://dashboard.render.com with GitHub → **New → Blueprint** → choose the repository → **Apply**.
   Render reads `render.yaml`, builds the Dockerfile (first build ~5–8 min) and gives you a URL like
   `https://agentops-desk.onrender.com`.
3. Open the URL and use the demo-account buttons on the sign-in page.

Every push to the default branch redeploys automatically (`autoDeploy: true`).

## Behaviour on the free tier
- The service sleeps after ~15 minutes without traffic; the first request afterwards takes about a minute.
  Open the site a few minutes before the viva.
- Storage is ephemeral: each restart or redeploy starts from the clean seeded demo data. Uploaded documents and
  new tickets do not survive a restart.
- 512 MB RAM. ChromaDB is not installed in the image; retrieval uses the keyword backend.

## Security notes for a public demo
- Demo accounts (including the administrator) are public by design, and their password is shown on the sign-in
  page. Anyone with the URL can submit requests, approve actions, upload documents, change runtime settings or
  reset the demo data. All IT actions are sandboxed, so nothing real is affected, but treat the site as a shared
  demo, not a private system. To lock it down, set `DEMO_ACCOUNTS_ENABLED=false` and `DEMO_PASSWORD` to a secret,
  then sign in with the email/password form.
- **Do not set `ANTHROPIC_API_KEY` on the public demo** while demo accounts are enabled, or visitors could run live
  LLM requests on your account.
- `COOKIE_SECURE=true` is set because Render serves HTTPS.
- Rate limiting is in-process and best effort; it uses the first `X-Forwarded-For` address when requests arrive via
  the internal proxy.

## Verify a deployment
```bash
curl https://<your-app>.onrender.com/api/health
cd frontend && BASE_URL=https://<your-app>.onrender.com npx playwright test
```
The Playwright suite creates a few workflows on the deployed demo (they disappear on the next restart).

## Other hosts
The same root `Dockerfile` runs anywhere that runs containers and sets `PORT` (Railway, Fly.io, a VPS):
`docker build -t agentops-desk . && docker run -p 10000:10000 agentops-desk`.
