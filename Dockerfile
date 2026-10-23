# Single-container production image: Next.js (public port) + FastAPI (internal, 127.0.0.1:8000).
# The browser only talks to Next.js, which proxies /api/* to FastAPI inside the container.

# ---------- 1. build the Next.js standalone server ----------
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
ENV NEXT_TELEMETRY_DISABLED=1 BACKEND_URL=http://127.0.0.1:8000
RUN npm run build \
 && mkdir -p .next/standalone/public .next/standalone/.next \
 && cp -r public/. .next/standalone/public/ \
 && cp -r .next/static .next/standalone/.next/static

# ---------- 2. runtime: Python backend + Node binary for the web server ----------
FROM python:3.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
COPY --from=web /usr/local/bin/node /usr/local/bin/node

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=web /web/.next/standalone /app/web
COPY deploy/start.sh /app/start.sh
RUN chmod +x /app/start.sh && useradd --create-home appuser && chown -R appuser /app
USER appuser

ENV PORT=10000
EXPOSE 10000
CMD ["/app/start.sh"]
