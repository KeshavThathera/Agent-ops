"""Password hashing, session tokens, secret/PII redaction, and simple rate limiting."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import threading
import time
from collections import defaultdict, deque
from typing import Any

# ---------------------------------------------------------------- passwords (stdlib scrypt)
_SCRYPT = {"n": 2**14, "r": 8, "p": 1, "dklen": 32}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt_hex, digest_hex = stored.split("$")
    except ValueError:
        return False
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), **_SCRYPT)
    return hmac.compare_digest(digest.hex(), digest_hex)


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ---------------------------------------------------------------- redaction
_REDACTIONS: list[tuple[str, re.Pattern[str]]] = [
    ("api_key", re.compile(r"\b(sk-[A-Za-z0-9_\-]{16,}|sk-ant-[A-Za-z0-9_\-]{10,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,})\b")),
    ("bearer_token", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9\-._~+/]{16,}=*")),
    ("password", re.compile(r"(?i)\b(password|passwd|pwd|passcode|pin)\s*[:=]\s*\S+")),
    ("password", re.compile(r"(?i)\b(my password is|password is)\s+\S+")),
    ("card_number", re.compile(r"\b(?:\d[ -]?){13,19}\b")),
    ("national_id", re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b")),  # Aadhaar-like 12 digit numbers
]

SENSITIVE_KEYS = {"password", "secret", "token", "api_key", "apikey", "authorization", "cookie", "otp"}


def redact_text(text: str) -> tuple[str, list[str]]:
    found: list[str] = []
    for label, pattern in _REDACTIONS:
        if pattern.search(text):
            found.append(label)
            text = pattern.sub(f"[REDACTED:{label}]", text)
    return text, sorted(set(found))


def sanitize(value: Any, depth: int = 0) -> Any:
    """Recursively redact secrets for storage in tool-call arguments and audit details."""
    if depth > 6:
        return "[truncated]"
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if str(k).lower() in SENSITIVE_KEYS:
                out[k] = "[REDACTED]"
            else:
                out[k] = sanitize(v, depth + 1)
        return out
    if isinstance(value, list):
        return [sanitize(v, depth + 1) for v in value[:50]]
    if isinstance(value, str):
        text, _ = redact_text(value)
        return text[:4000]
    return value


# ---------------------------------------------------------------- rate limiting (in-process)
class RateLimiter:
    """Sliding-window limiter. In-memory, so it is per-process; adequate for a single-node prototype."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str, limit: int, window_seconds: float) -> bool:
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > window_seconds:
                q.popleft()
            if len(q) >= limit:
                return False
            q.append(now)
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


rate_limiter = RateLimiter()
