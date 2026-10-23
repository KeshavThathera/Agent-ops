"""FastAPI application entry point."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import inspect

from app import worker
from app.auth import csrf_guard
from app.config import get_settings
from app.db import get_engine
from app.errors import install_error_handlers
from app.routes_admin import router as admin_router
from app.routes_core import router as core_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    s = get_settings()
    if "workflow_runs" not in inspect(get_engine()).get_table_names():
        raise RuntimeError("Database is not migrated. Run: python -m app.cli init")
    if s.worker_enabled:
        worker.start(s.worker_poll_seconds)
    yield
    worker.stop()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="AgentOps Desk API", version="1.0.0", lifespan=lifespan,
                  description="Agentic AI IT Operations & Support Platform (final-year project prototype)")
    app.add_middleware(CORSMiddleware, allow_origins=s.cors_origin_list, allow_credentials=True,
                       allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["Content-Type", "X-Requested-With", "Last-Event-ID"])
    app.middleware("http")(csrf_guard)
    install_error_handlers(app)
    app.include_router(core_router)
    app.include_router(admin_router)

    @app.get("/api/health")
    def health():
        return {"status": "ok", "worker": worker.status()}

    return app


app = create_app()
