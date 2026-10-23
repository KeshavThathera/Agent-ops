"""Each test gets a fresh SQLite database with reference data seeded; the worker is disabled and
jobs are drained inline so tests are deterministic."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))


@pytest.fixture()
def app_env(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CHROMA_DIR", str(tmp_path / "chroma"))
    monkeypatch.setenv("WORKER_ENABLED", "false")
    monkeypatch.setenv("DEMO_ACCOUNTS_ENABLED", "true")
    monkeypatch.setenv("APP_ENV", "demo")
    monkeypatch.setenv("RETRIEVAL_BACKEND", "keyword")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    from app import config, db as dbmod, rag
    from app.security import rate_limiter

    config.get_settings.cache_clear()
    dbmod.reset_engine()
    rag.keyword_index.invalidate()
    rate_limiter.reset()
    from app.db import Base, get_engine, session_scope
    from app import models  # noqa: F401
    from app.seed import seed_reference_data

    Base.metadata.create_all(get_engine())
    with session_scope() as s:
        seed_reference_data(s)
    yield
    dbmod.reset_engine()
    config.get_settings.cache_clear()


@pytest.fixture()
def client(app_env):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app()) as c:
        c.headers.update({"X-Requested-With": "agentops-desk"})
        yield c


def login(client, email: str):
    client.cookies.clear()
    r = client.post("/api/auth/demo-login", json={"email": email})
    assert r.status_code == 200, r.text
    return r.json()


RIYA = "riya.mehta@agentops.demo"
ARJUN = "arjun.verma@agentops.demo"
SANA = "sana.khan@agentops.demo"
VIKRAM = "vikram.rao@agentops.demo"
NEHA = "neha.joshi@agentops.demo"


def submit(client, text: str, key: str | None = None, **opts):
    import uuid

    body = {"text": text, "mode": "demo", "idempotency_key": key or uuid.uuid4().hex}
    if opts:
        body["demo_options"] = opts
    r = client.post("/api/requests", json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()["workflow_id"]


def drain():
    from app import worker

    worker.drain()


def detail(client, wf_id: str) -> dict:
    r = client.get(f"/api/workflows/{wf_id}")
    assert r.status_code == 200, r.text
    return r.json()


def pending_approval(d: dict) -> dict:
    return next(a for a in d["approvals"] if a["status"] == "pending")
