"""Sandboxed IT environment.

Every workflow gets its own simulated laptop / account / printer records in the database,
primed with a deterministic fault fixture for the classified category. Diagnostics read
this state; approved remediations mutate it; verification re-reads it. Nothing here
inspects or changes a real device, including the visitor's own computer.
"""

from __future__ import annotations

import copy
from typing import Any

from sqlalchemy.orm import Session

from app.models import SandboxResource, WorkflowRun

HEALTHY_LAPTOP: dict[str, Any] = {
    "os": "Windows 11 23H2 (sandbox image)",
    "network": {"adapter_up": True, "gateway": True, "dns": True, "internet": True},
    "vpn": {"client": "CorpVPN 5.2", "profile": "corp-default", "session": "valid", "tunnel": "up"},
    "wifi": {"adapter": "enabled", "ssid": "CORP-WIFI", "signal_dbm": -55, "connected": True},
    "performance": {"cpu_pct": 18, "memory_pct": 41, "disk_free_pct": 46, "top_process": "explorer.exe"},
    "mail": {"client": "Outlook (sandbox)", "sync": "ok", "last_sync_minutes": 2, "error": None},
    "applied_remediations": [],
}

FIXTURES: dict[str, dict[str, Any]] = {
    "vpn": {
        "label": "VPN session token expired",
        "laptop": {"vpn": {"session": "expired", "tunnel": "down", "last_error": "AUTH_SESSION_EXPIRED (token issued 3 days ago)"}},
    },
    "wifi": {
        "label": "Wi-Fi adapter disabled",
        "laptop": {
            "wifi": {"adapter": "disabled", "connected": False, "signal_dbm": None},
            "network": {"adapter_up": False, "gateway": False, "dns": False, "internet": False},
        },
    },
    "performance": {
        "label": "Runaway indexing process and low disk space",
        "laptop": {"performance": {"cpu_pct": 96, "memory_pct": 88, "disk_free_pct": 4, "top_process": "SearchIndexer.exe"}},
    },
    "email": {
        "label": "Mail sync profile cache is stale",
        "laptop": {"mail": {"sync": "stalled", "last_sync_minutes": 380, "error": "SYNC_TOKEN_REJECTED (stale profile cache)"}},
    },
    "account": {"label": "Directory account locked after failed sign-ins", "account": {"locked": True, "failed_attempts": 6}},
    "printer": {"label": "Printer fuser hardware fault", "printer": {"status": "error", "hardware_fault": True, "error_code": "50.2 Fuser error"}},
}

SERVICES: dict[str, dict[str, Any]] = {
    "vpn-gateway": {"name": "VPN gateway (sandbox)", "status": "operational", "region": "campus-dc-1"},
    "wifi-controller": {"name": "Wireless LAN controller (sandbox)", "status": "operational", "region": "campus"},
    "identity-provider": {"name": "Directory / identity provider (sandbox)", "status": "operational", "region": "cloud"},
    "mail-service": {"name": "Mail service (sandbox)", "status": "operational", "region": "cloud"},
    "print-server": {"name": "Print server PRINT-01 (sandbox)", "status": "operational", "region": "campus"},
}

# Remediation catalog. action_class drives policy.py; nothing outside this catalog can execute.
REMEDIATIONS: dict[str, dict[str, Any]] = {
    "refresh_vpn_session": {
        "action_class": "device_config_change",
        "target_kind": "laptop",
        "title": "Refresh VPN session and re-apply corp-default profile",
        "expected_effect": "Issues a new VPN session token and reconnects the tunnel on the sandbox laptop.",
        "verify_check": "vpn_connectivity",
        "category": "vpn",
    },
    "enable_wifi_adapter": {
        "action_class": "device_config_change",
        "target_kind": "laptop",
        "title": "Enable the wireless network adapter",
        "expected_effect": "Turns the sandbox Wi-Fi adapter on and rejoins CORP-WIFI.",
        "verify_check": "wifi_connectivity",
        "category": "wifi",
    },
    "unlock_account": {
        "action_class": "account_change",
        "target_kind": "account",
        "title": "Unlock directory account and require password change at next sign-in",
        "expected_effect": "Clears the lockout on the sandbox directory account and resets the failed-attempt counter.",
        "verify_check": "account_signin",
        "category": "account",
    },
    "reset_mail_sync_profile": {
        "action_class": "device_config_change",
        "target_kind": "laptop",
        "title": "Rebuild the mail client's sync profile cache",
        "expected_effect": "Clears the stale profile cache so the sandbox mail client re-authenticates and syncs.",
        "verify_check": "mail_sync",
        "category": "email",
    },
    "clear_temp_and_restart_indexer": {
        "action_class": "device_config_change",
        "target_kind": "laptop",
        "title": "Clear temporary files and restart the search indexer",
        "expected_effect": "Frees disk space and restarts the runaway indexing service on the sandbox laptop.",
        "verify_check": "performance",
        "category": "performance",
    },
    "restart_print_spooler": {
        "action_class": "device_config_change",
        "target_kind": "printer",
        "title": "Restart the print spooler and clear the queue",
        "expected_effect": "Restarts the spooler on the sandbox print server. Does not repair hardware faults.",
        "verify_check": "printer_output",
        "category": "printer",
    },
}

VERIFY_CHECKS = ["vpn_connectivity", "wifi_connectivity", "account_signin", "mail_sync", "performance", "printer_output"]


def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def prime(db: Session, wf: WorkflowRun, category: str, requester_email: str) -> dict[str, Any]:
    """Create this workflow's sandbox resources (idempotent) with the category's fault fixture."""
    existing = wf.state.get("sandbox")
    if existing:
        return existing
    short = wf.id[-6:].upper()
    fixture = FIXTURES.get(category, {})
    laptop = SandboxResource(
        id=f"SBX-LT-{short}",
        kind="laptop",
        owner_id=wf.requester_id,
        workflow_id=wf.id,
        state=_deep_merge({**HEALTHY_LAPTOP, "hostname": f"LT-{short}"}, fixture.get("laptop", {})),
    )
    account = SandboxResource(
        id=f"SBX-ACCT-{short}",
        kind="account",
        owner_id=wf.requester_id,
        workflow_id=wf.id,
        state=_deep_merge(
            {"username": requester_email, "locked": False, "failed_attempts": 0, "lockout_policy": "5 attempts / 30 min",
             "mfa": "enrolled", "applied_remediations": []},
            fixture.get("account", {}),
        ),
    )
    printer = SandboxResource(
        id=f"SBX-PRN-{short}",
        kind="printer",
        owner_id=None,
        workflow_id=wf.id,
        state=_deep_merge(
            {"name": "PRN-3F-EAST", "model": "LaserJet M507 (sandbox)", "status": "ready", "error_code": None,
             "queue_jobs": 7, "spooler": "running", "hardware_fault": False, "toner_pct": 62, "applied_remediations": []},
            fixture.get("printer", {}),
        ),
    )
    db.add_all([laptop, account, printer])
    info = {
        "device_id": laptop.id,
        "account_id": account.id,
        "printer_id": printer.id,
        "fixture": fixture.get("label", "No fault fixture (healthy sandbox)"),
    }
    wf.state = {**wf.state, "sandbox": info}
    return info


def get(db: Session, resource_id: str) -> SandboxResource | None:
    return db.get(SandboxResource, resource_id)


def apply_remediation(res: SandboxResource, action: str, idempotency_key: str, ineffective: bool) -> dict[str, Any]:
    state = copy.deepcopy(res.state)
    applied = state.setdefault("applied_remediations", [])
    for entry in applied:
        if entry["key"] == idempotency_key:
            return {**entry["result"], "idempotent_replay": True}

    before = copy.deepcopy(state)
    if not ineffective:
        if action == "refresh_vpn_session":
            state["vpn"].update({"session": "valid", "tunnel": "up", "last_error": None})
        elif action == "enable_wifi_adapter":
            state["wifi"].update({"adapter": "enabled", "connected": True, "signal_dbm": -57})
            state["network"].update({"adapter_up": True, "gateway": True, "dns": True, "internet": True})
        elif action == "unlock_account":
            state.update({"locked": False, "failed_attempts": 0, "must_change_password": True})
        elif action == "reset_mail_sync_profile":
            state["mail"].update({"sync": "ok", "last_sync_minutes": 0, "error": None})
        elif action == "clear_temp_and_restart_indexer":
            state["performance"].update({"cpu_pct": 22, "memory_pct": 47, "disk_free_pct": 31, "top_process": "explorer.exe"})
        elif action == "restart_print_spooler":
            state.update({"spooler": "running", "queue_jobs": 0})  # hardware faults persist
    changed = sorted(k for k in state if k != "applied_remediations" and state.get(k) != before.get(k))
    result = {
        "action": action,
        "target_id": res.id,
        "applied": True,
        "changed_fields": changed,
        "note": "Injected fault: remediation applied but had no effect" if ineffective else None,
        "sandbox": True,
    }
    applied.append({"key": idempotency_key, "action": action, "result": result})
    res.state = state
    return result


def verify(res: SandboxResource, check: str) -> dict[str, Any]:
    s = res.state
    obs: dict[str, Any]
    if check == "vpn_connectivity":
        ok = s["vpn"]["session"] == "valid" and s["vpn"]["tunnel"] == "up"
        obs = {"tunnel": s["vpn"]["tunnel"], "session": s["vpn"]["session"], "probe": "intranet.corp.example reachable" if ok else "intranet unreachable"}
    elif check == "wifi_connectivity":
        ok = s["wifi"]["connected"] and s["network"]["internet"]
        obs = {"adapter": s["wifi"]["adapter"], "ssid": s["wifi"]["ssid"] if ok else None, "internet": s["network"]["internet"]}
    elif check == "account_signin":
        ok = not s["locked"]
        obs = {"locked": s["locked"], "failed_attempts": s["failed_attempts"], "test_bind": "succeeded" if ok else "rejected: account locked"}
    elif check == "mail_sync":
        ok = s["mail"]["sync"] == "ok"
        obs = {"sync": s["mail"]["sync"], "last_sync_minutes": s["mail"]["last_sync_minutes"]}
    elif check == "performance":
        p = s["performance"]
        ok = p["cpu_pct"] < 70 and p["disk_free_pct"] > 10
        obs = {"cpu_pct": p["cpu_pct"], "disk_free_pct": p["disk_free_pct"], "top_process": p["top_process"]}
        # Responsiveness is partly subjective, so the employee must also confirm.
        return {"check": check, "verified": ok, "method": "diagnostic", "requires_user_confirmation": ok, "observations": obs, "sandbox": True}
    elif check == "printer_output":
        ok = not s["hardware_fault"] and s["status"] == "ready"
        obs = {"status": s["status"], "error_code": s["error_code"], "test_page": "printed" if ok else "failed"}
    else:
        return {"check": check, "verified": False, "method": "diagnostic", "observations": {"error": "unknown check"}, "sandbox": True}
    return {"check": check, "verified": bool(ok), "method": "diagnostic", "requires_user_confirmation": False, "observations": obs, "sandbox": True}
