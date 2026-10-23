"""Runtime configuration loaded from environment variables (see .env.example).

Secrets (provider API keys) are read here and never serialised to clients,
browser storage, or audit logs. Only booleans such as "configured" leave the server.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = "development"  # development | demo | production
    database_url: str = f"sqlite:///{(BACKEND_DIR / 'data' / 'agentops.db').as_posix()}"
    data_dir: Path = BACKEND_DIR / "data"

    # Demo accounts are a convenience for the viva. They must be explicitly enabled.
    demo_accounts_enabled: bool = False
    demo_password: str = "demo-pass-2026"

    session_ttl_hours: int = 12
    cookie_secure: bool = False  # set true behind HTTPS
    cors_origins: str = "http://localhost:3000"

    # Background worker that advances workflows. Tests disable it and drain jobs inline.
    worker_enabled: bool = True
    worker_poll_seconds: float = 0.25

    # LLM provider (live mode). Only the Anthropic provider is implemented.
    llm_provider: str = "anthropic"
    anthropic_api_key: str | None = None
    llm_classifier_model: str = "claude-haiku-5-5"
    llm_planner_model: str = "claude-opus-5-5"
    llm_refusal_fallback: bool = True
    llm_timeout_seconds: float = 60.0

    # Retrieval backend: "keyword" (deterministic TF-IDF) or "chroma" (vector search with
    # ChromaDB's local ONNX MiniLM embedding model; downloads ~80 MB on first use).
    retrieval_backend: str = "keyword"
    chroma_dir: Path = BACKEND_DIR / "data" / "chroma"

    max_upload_bytes: int = 5 * 1024 * 1024
    request_max_chars: int = 2000

    @property
    def llm_configured(self) -> bool:
        return bool(self.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY"))

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    # Relative paths in .env are relative to the backend folder, not the process working directory.
    if s.database_url.startswith("sqlite:///./"):
        s.database_url = f"sqlite:///{(BACKEND_DIR / s.database_url.removeprefix('sqlite:///./')).as_posix()}"
    for attr in ("data_dir", "chroma_dir"):
        p = getattr(s, attr)
        if not p.is_absolute():
            setattr(s, attr, BACKEND_DIR / p)
    s.data_dir.mkdir(parents=True, exist_ok=True)
    (s.data_dir / "uploads").mkdir(parents=True, exist_ok=True)
    return s
