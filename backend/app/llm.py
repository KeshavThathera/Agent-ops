"""Hosted LLM adapter (live mode). Implemented provider: Anthropic Claude via the official SDK.

The model is used for two bounded jobs: classifying the request and drafting a plan.
Both return JSON constrained by a JSON schema (output_config.format) and are then
validated again with Pydantic. Policy, approvals, state transitions and completion
checks never depend on model output.

Errors are raised as LLMError and surface on the workflow; a live run is never
silently switched to the demo planner.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from app.config import get_settings

# USD per million tokens (input, output). Anthropic list prices as published Oct 2026; estimates only.
PRICES: dict[str, tuple[float, float]] = {
    "claude-opus-5-5": (4.00, 20.00),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-haiku-5-5": (0.10, 0.50),
}
# Models that accept the server-side refusal fallback ("default" form, Claude API only).
_FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-1"}


class LLMError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code  # not_configured | auth | rate_limited | provider_error | network | refusal | truncated | malformed_output
        self.message = message


@dataclass
class LLMResult:
    data: dict[str, Any]
    model: str
    input_tokens: int
    output_tokens: int
    parsed: Any = None

    @property
    def cost_usd(self) -> float:
        pin, pout = PRICES.get(self.model, (0.0, 0.0))
        return round(self.input_tokens / 1e6 * pin + self.output_tokens / 1e6 * pout, 6)


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    return LLMResult({}, model, input_tokens, output_tokens).cost_usd


def models(db=None) -> dict[str, str]:
    s = get_settings()
    routing: dict[str, Any] = {}
    if db is not None:
        from app import runtime_settings

        routing = runtime_settings.get_section(db, "model_routing")
    return {
        "classifier": routing.get("classifier_model") or s.llm_classifier_model,
        "planner": routing.get("planner_model") or s.llm_planner_model,
    }


def structured_call(model: str, system: str, user: str, output_model: type[BaseModel], effort: str = "low") -> LLMResult:
    """Calls messages.parse(output_format=...), which converts the Pydantic schema to the supported
    JSON-schema subset and validates the reply. pydantic.ValidationError propagates to the caller,
    which makes one repair attempt (see agent.call_validated)."""
    s = get_settings()
    if not s.llm_configured:
        raise LLMError("not_configured", "No LLM provider credentials are configured (ANTHROPIC_API_KEY).")
    import anthropic

    client = anthropic.Anthropic(api_key=s.anthropic_api_key or None, timeout=s.llm_timeout_seconds, max_retries=2)
    kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": 4000,
        "system": system,
        "messages": [{"role": "user", "content": user}],
        "output_config": {"effort": effort},
        "output_format": output_model,
    }
    try:
        if s.llm_refusal_fallback and model in _FALLBACK_MODELS:
            resp = client.beta.messages.parse(**kwargs, betas=["server-side-fallback-2026-07-01"], fallbacks="default")
        else:
            resp = client.messages.parse(**kwargs)
    except anthropic.AuthenticationError as exc:
        raise LLMError("auth", "LLM provider rejected the API key.") from exc
    except anthropic.PermissionDeniedError as exc:
        raise LLMError("auth", "API key lacks permission for this model.") from exc
    except anthropic.NotFoundError as exc:
        raise LLMError("provider_error", f"Model '{model}' was not found.") from exc
    except anthropic.RateLimitError as exc:
        raise LLMError("rate_limited", "LLM provider rate limit reached.") from exc
    except anthropic.BadRequestError as exc:
        raise LLMError("provider_error", f"Provider rejected the request: {exc.message[:300]}") from exc
    except anthropic.APIStatusError as exc:
        raise LLMError("provider_error", f"Provider error HTTP {exc.status_code}.") from exc
    except anthropic.APIConnectionError as exc:
        raise LLMError("network", "Could not reach the LLM provider.") from exc

    if resp.stop_reason == "refusal":
        raise LLMError("refusal", "The model declined this request.")
    if resp.stop_reason == "max_tokens":
        raise LLMError("truncated", "Model output was truncated.")
    parsed = resp.parsed_output
    if parsed is None:
        raise LLMError("malformed_output", "Model returned no parseable structured output.")
    return LLMResult(parsed.model_dump(), resp.model or model, resp.usage.input_tokens, resp.usage.output_tokens, parsed)
