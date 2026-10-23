"""MCP client: launches app.mcp_server over stdio and invokes tools on it.

One short-lived connection per call keeps the prototype simple and restart-safe;
the cost is process start-up latency (roughly a second), which is visible in tool-call durations.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any

from mcp import Client, StdioServerParameters

from app.config import BACKEND_DIR


def _params() -> StdioServerParameters:
    return StdioServerParameters(command=sys.executable, args=["-m", "app.mcp_server"], cwd=str(BACKEND_DIR), env=dict(os.environ))


def _text(result: Any) -> str:
    return "\n".join(getattr(c, "text", "") for c in (result.content or []))


async def call_tool(name: str, args: dict[str, Any], timeout: float) -> dict[str, Any]:
    from app.tools import ToolError

    async def _go() -> dict[str, Any]:
        async with Client(_params(), read_timeout_seconds=timeout) as client:
            res = await client.call_tool(name, args, read_timeout_seconds=timeout)
        if res.is_error:
            raise ToolError("permanent", f"MCP tool error: {_text(res)[:300]}")
        data = res.structured_content
        if data is None:
            data = json.loads(_text(res) or "{}")
        if isinstance(data, dict) and set(data) == {"result"} and isinstance(data["result"], dict):
            data = data["result"]
        return {**data, "_mcp": {"server": "agentops-desk-sandbox-tools", "transport": "stdio"}}

    try:
        return await asyncio.wait_for(_go(), timeout=timeout + 15)  # allowance for process start-up
    except asyncio.TimeoutError as exc:
        raise ToolError("timeout", f"MCP call to {name} timed out") from exc
    except ToolError:
        raise
    except Exception as exc:  # spawn failures, protocol errors
        raise ToolError("transient", f"MCP connection failed: {type(exc).__name__}: {str(exc)[:200]}") from exc


async def probe(call_service: str = "vpn-gateway") -> dict[str, Any]:
    """Connect, list tools, and make one real call. Used by the Tools page health check."""
    async with Client(_params(), read_timeout_seconds=20) as client:
        tools = await client.list_tools()
        res = await client.call_tool("check_service_status", {"service": call_service})
        info = client.server_info
        return {
            "connected": True,
            "protocol_version": client.protocol_version,
            "server_name": info.name if info else None,
            "server_version": info.version if info else None,
            "tools": [{"name": t.name, "description": t.description} for t in tools.tools],
            "sample_call": {"tool": "check_service_status", "is_error": res.is_error, "result": res.structured_content},
        }
