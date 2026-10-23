"""Admin-editable runtime settings stored in the database (non-secret only)."""

from __future__ import annotations

import copy
from typing import Any

from sqlalchemy.orm import Session

from app.models import AppSetting

DEFAULTS: dict[str, dict[str, Any]] = {
    "retrieval": {"top_k": 4, "min_relevance": 0.12},
    "execution": {"max_steps": 14, "max_active_seconds": 90, "tool_timeout_seconds": 8, "max_clarifications": 2},
    "retry": {"max_attempts": 3, "base_backoff_seconds": 0.4, "max_backoff_seconds": 4.0},
    # Editable risk policy decisions. Locked policies live in policy.py and cannot be changed here.
    "risk_policy": {"device_config_change": "approval_required", "external_notification": "approval_required"},
    "model_routing": {"classifier_model": None, "planner_model": None},  # None -> use env defaults
    "demo": {"ticketing_fault": "none", "verification_fault": "none", "tool_transport": "in_process"},
}

ALLOWED_VALUES: dict[tuple[str, str], set[Any]] = {
    ("risk_policy", "device_config_change"): {"approval_required", "automatic"},
    ("risk_policy", "external_notification"): {"approval_required", "unavailable"},
    ("demo", "ticketing_fault"): {"none", "transient", "permanent"},
    ("demo", "verification_fault"): {"none", "ineffective"},
    ("demo", "tool_transport"): {"in_process", "mcp"},
}

NUMERIC_BOUNDS: dict[tuple[str, str], tuple[float, float]] = {
    ("retrieval", "top_k"): (1, 10),
    ("retrieval", "min_relevance"): (0.0, 0.95),
    ("execution", "max_steps"): (4, 40),
    ("execution", "max_active_seconds"): (10, 600),
    ("execution", "tool_timeout_seconds"): (1, 60),
    ("execution", "max_clarifications"): (1, 5),
    ("retry", "max_attempts"): (1, 6),
    ("retry", "base_backoff_seconds"): (0.1, 10),
    ("retry", "max_backoff_seconds"): (0.5, 60),
}


def get_section(db: Session, key: str) -> dict[str, Any]:
    row = db.get(AppSetting, key)
    merged = copy.deepcopy(DEFAULTS.get(key, {}))
    if row and row.value:
        merged.update(row.value)
    return merged


def get_all(db: Session) -> dict[str, dict[str, Any]]:
    return {k: get_section(db, k) for k in DEFAULTS}


def validate_section(key: str, value: dict[str, Any]) -> dict[str, Any]:
    if key not in DEFAULTS:
        raise ValueError(f"Unknown settings section '{key}'")
    clean: dict[str, Any] = {}
    for field, v in value.items():
        if field not in DEFAULTS[key]:
            raise ValueError(f"Unknown setting '{key}.{field}'")
        if (key, field) in ALLOWED_VALUES and v not in ALLOWED_VALUES[(key, field)]:
            raise ValueError(f"'{v}' is not allowed for {key}.{field}")
        if (key, field) in NUMERIC_BOUNDS:
            lo, hi = NUMERIC_BOUNDS[(key, field)]
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not lo <= v <= hi:
                raise ValueError(f"{key}.{field} must be a number between {lo} and {hi}")
        if key == "model_routing" and v is not None and (not isinstance(v, str) or len(v) > 80):
            raise ValueError("Model names must be short strings")
        clean[field] = v
    return clean


def put_section(db: Session, key: str, value: dict[str, Any], user_id: str | None) -> dict[str, Any]:
    clean = validate_section(key, value)
    row = db.get(AppSetting, key)
    if row is None:
        row = AppSetting(key=key, value={})
        db.add(row)
    merged = dict(row.value or {})
    merged.update(clean)
    row.value = merged
    row.updated_by = user_id
    return get_section(db, key) | merged
