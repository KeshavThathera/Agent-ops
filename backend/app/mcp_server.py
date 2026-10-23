"""Minimal MCP server exposing the read-only sandbox tools over stdio.

Run directly:  python -m app.mcp_server
The backend's MCP client (app/mcp_client.py) launches this process when the
"tool_transport" setting is "mcp". Only read-only tools are exposed; anything with
side effects stays behind the in-process policy and approval pipeline.

Note: stdout is the MCP protocol channel, so nothing in this process may print to it.
"""

from __future__ import annotations

from typing import Any, Literal

from mcp.server.mcpserver import MCPServer

from app.db import session_scope
from app.tools import REGISTRY, ToolContext, ToolError

server = MCPServer(
    "agentops-desk-sandbox-tools",
    instructions="Read-only IT diagnostics against the AgentOps Desk sandbox. No real devices are accessed.",
    version="1.0.0",
)


def _call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    spec = REGISTRY[name]
    model = spec.input_model.model_validate(args)
    with session_scope() as db:
        try:
            return spec.impl(ToolContext(db=db), model)
        except ToolError as exc:
            raise ValueError(exc.message) from exc


@server.tool(name="search_knowledge_base", description=REGISTRY["search_knowledge_base"].description)
def search_knowledge_base(query: str, top_k: int | None = None) -> dict[str, Any]:
    return _call("search_knowledge_base", {"query": query, **({"top_k": top_k} if top_k else {})})


@server.tool(name="get_device_status", description=REGISTRY["get_device_status"].description)
def get_device_status(device_id: str) -> dict[str, Any]:
    return _call("get_device_status", {"device_id": device_id})


@server.tool(name="get_account_status", description=REGISTRY["get_account_status"].description)
def get_account_status(account_id: str) -> dict[str, Any]:
    return _call("get_account_status", {"account_id": account_id})


@server.tool(name="run_network_diagnostics", description=REGISTRY["run_network_diagnostics"].description)
def run_network_diagnostics(device_id: str, target: Literal["internet", "vpn", "wifi", "mail"]) -> dict[str, Any]:
    return _call("run_network_diagnostics", {"device_id": device_id, "target": target})


@server.tool(name="check_service_status", description=REGISTRY["check_service_status"].description)
def check_service_status(
    service: Literal["vpn-gateway", "wifi-controller", "identity-provider", "mail-service", "print-server"],
) -> dict[str, Any]:
    return _call("check_service_status", {"service": service})


if __name__ == "__main__":
    server.run()
