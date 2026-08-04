"""OpenAI chat completions (JSON mode) or WAIT stub without API key."""

from __future__ import annotations

import json
import logging
import os
import random
import re
import time
from dataclasses import dataclass
from typing import Any

import requests

DEFAULT_MODEL = "gpt-5.4"
DEFAULT_BASE = "https://api.openai.com/v1"
# Generous defaults: entry prompts are large; TPM 429s often need minutes, not seconds.
DEFAULT_MAX_RETRIES = 6
DEFAULT_RETRY_BASE_SECONDS = 15.0
DEFAULT_RETRY_MAX_SECONDS = 180.0

log = logging.getLogger(__name__)

_RETRY_IN_SECONDS_RE = re.compile(r"try again in\s+([\d.]+)\s*s", re.IGNORECASE)


class OpenAIHttpError(RuntimeError):
    """HTTP failure from OpenAI after retries (or non-retryable error)."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None,
        error_type: str | None,
        body_snippet: str = "",
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_type = error_type
        self.body_snippet = body_snippet

    @property
    def is_rate_limit(self) -> bool:
        """Transient 429 (retry later); not billing/quota exhaustion."""
        if self.status_code != 429:
            return False
        return self.error_type != "insufficient_quota"

    @property
    def is_insufficient_quota(self) -> bool:
        return self.status_code == 429 and self.error_type == "insufficient_quota"


@dataclass(frozen=True)
class LlmUsage:
    model: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    estimated_cost_usd: float | None
    cost_estimated: bool
    source: str


def estimate_cost_usd(
    *,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    pricing: dict[str, dict[str, float]] | None,
) -> tuple[float | None, bool]:
    if not pricing:
        return None, False
    row = pricing.get(model) or pricing.get(model.split("/")[-1])
    if not row:
        return None, False
    try:
        p = float(row.get("prompt_per_1m", 0.0))
        c = float(row.get("completion_per_1m", 0.0))
    except (TypeError, ValueError):
        return None, False
    cost = (prompt_tokens / 1_000_000.0) * p + (completion_tokens / 1_000_000.0) * c
    return round(cost, 6), True


def _stub_verdict() -> dict[str, Any]:
    return {
        "action": "WAIT",
        "conviction": 0.5,
        "direction": "long",
        "headline": "Stub evaluation — set OPENAI_API_KEY",
        "why": "No API key configured.",
        "summary": "No API key configured; stub evaluation.",
        "why_now": "Set OPENAI_API_KEY to enable model evaluation.",
        "risk_level": "medium",
        "risk_score": 50,
        "hold_days": 3,
        "entry_zone": {"min_price": 0.0, "max_price": 0.0, "ideal_price": 0.0},
        "stop_loss": 0.0,
        "targets": [
            {"price": 0.0, "label": "T1"},
            {"price": 0.0, "label": "T2"},
            {"price": 0.0, "label": "T3"},
        ],
        "timeframe": "3-5 days",
        "risk_reward_ratio": 0.0,
        "position_size_suggestion": "small",
        "risks": ["LLM disabled"],
        "invalidation": "n/a",
        "confidence_factors": [],
        "invalidation_conditions": [],
        "checklist": [
            {"id": "api", "label": "OpenAI configured", "pass": False},
        ],
    }


def _retry_settings() -> tuple[int, float, float]:
    """Read bounded retry settings, falling back safely on invalid env values."""
    try:
        retries = max(0, int(os.getenv("OPENAI_MAX_RETRIES", DEFAULT_MAX_RETRIES)))
    except (TypeError, ValueError):
        retries = DEFAULT_MAX_RETRIES
    try:
        base_seconds = max(
            0.0,
            float(os.getenv("OPENAI_RETRY_BASE_SECONDS", DEFAULT_RETRY_BASE_SECONDS)),
        )
    except (TypeError, ValueError):
        base_seconds = DEFAULT_RETRY_BASE_SECONDS
    try:
        max_seconds = max(
            base_seconds,
            float(os.getenv("OPENAI_RETRY_MAX_SECONDS", DEFAULT_RETRY_MAX_SECONDS)),
        )
    except (TypeError, ValueError):
        max_seconds = max(base_seconds, DEFAULT_RETRY_MAX_SECONDS)
    return retries, base_seconds, max_seconds


def _error_payload(resp: requests.Response) -> dict[str, Any]:
    try:
        data = resp.json()
    except (ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    err = data.get("error")
    return err if isinstance(err, dict) else {}


def _error_type(resp: requests.Response) -> str | None:
    t = _error_payload(resp).get("type")
    return str(t) if t else None


def _retry_after_seconds(resp: requests.Response, *, attempt: int, base_seconds: float) -> float:
    """Prefer Retry-After header, then message 'try again in Xs', else exponential backoff."""
    retry_after = resp.headers.get("Retry-After")
    if retry_after:
        try:
            return max(0.0, float(retry_after))
        except ValueError:
            pass
    msg = str(_error_payload(resp).get("message") or "")
    match = _RETRY_IN_SECONDS_RE.search(msg)
    if match:
        try:
            return max(0.0, float(match.group(1)))
        except ValueError:
            pass
    return base_seconds * (2**attempt)


def _is_retryable_response(resp: requests.Response) -> bool:
    if resp.status_code in {408, 429, 500, 502, 503, 504}:
        if resp.status_code != 429:
            return True
        # Insufficient quota is a billing/configuration issue, not a transient rate limit.
        return _error_type(resp) != "insufficient_quota"
    return False


def _raise_http_error(resp: requests.Response) -> None:
    err = _error_payload(resp)
    err_type = str(err.get("type") or "") or None
    msg = str(err.get("message") or "").strip()
    snippet = (resp.text or "")[:400]
    if not msg:
        msg = f"{resp.status_code} Client Error for url: {resp.url}"
    else:
        msg = f"{resp.status_code} {msg}"
    if err_type:
        msg = f"{msg} (type={err_type})"
    raise OpenAIHttpError(
        msg,
        status_code=int(resp.status_code),
        error_type=err_type,
        body_snippet=snippet,
    )


def call_openai_json(
    *,
    system: str,
    user: str,
    model: str | None = None,
    pricing: dict[str, dict[str, float]] | None = None,
) -> tuple[dict[str, Any], LlmUsage, str]:
    """Returns (parsed_json, usage, raw_response_text)."""
    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    m = model or os.getenv("OPENAI_MODEL") or DEFAULT_MODEL
    if not api_key:
        stub = _stub_verdict()
        usage = LlmUsage(
            model=m,
            prompt_tokens=0,
            completion_tokens=0,
            total_tokens=0,
            estimated_cost_usd=None,
            cost_estimated=False,
            source="stub",
        )
        return stub, usage, json.dumps(stub, ensure_ascii=False)

    base = (os.getenv("OPENAI_BASE_URL") or DEFAULT_BASE).rstrip("/")
    url = f"{base}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    body = {
        "model": m,
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    max_retries, base_seconds, max_seconds = _retry_settings()
    resp: requests.Response | None = None
    for attempt in range(max_retries + 1):
        resp = requests.post(url, headers=headers, json=body, timeout=120)
        if not _is_retryable_response(resp) or attempt >= max_retries:
            break
        delay = min(
            _retry_after_seconds(resp, attempt=attempt, base_seconds=base_seconds),
            max_seconds,
        )
        # Small jitter so stacked workflows do not align on the same wake time.
        delay = delay + random.uniform(0.0, min(3.0, max(0.5, delay * 0.1)))
        log.warning(
            "OpenAI HTTP %s type=%s; retrying in %.1fs (%d/%d) model=%s",
            resp.status_code,
            _error_type(resp) or "unknown",
            delay,
            attempt + 1,
            max_retries,
            m,
        )
        time.sleep(delay)
    assert resp is not None
    if resp.status_code >= 400:
        _raise_http_error(resp)
    data = resp.json()
    content = data["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    usage_raw = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    prompt_tokens = int(usage_raw.get("prompt_tokens") or 0)
    completion_tokens = int(usage_raw.get("completion_tokens") or 0)
    total_tokens = int(usage_raw.get("total_tokens") or (prompt_tokens + completion_tokens))
    cost, cost_ok = estimate_cost_usd(
        model=m,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        pricing=pricing,
    )
    usage = LlmUsage(
        model=str(data.get("model") or m),
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
        estimated_cost_usd=cost,
        cost_estimated=cost_ok,
        source="openai",
    )
    return parsed, usage, content if isinstance(content, str) else str(content)


def normalize_verdict(raw: dict[str, Any]) -> dict[str, Any]:
    """Fill defaults for entry schema."""
    out = dict(raw)
    ez = out.get("entry_zone") if isinstance(out.get("entry_zone"), dict) else {}
    out["entry_zone"] = {
        "min_price": float(ez.get("min_price", 0.0) or 0.0),
        "max_price": float(ez.get("max_price", 0.0) or 0.0),
        "ideal_price": float(ez.get("ideal_price", 0.0) or 0.0),
    }
    out["stop_loss"] = float(out.get("stop_loss", 0.0) or 0.0)
    targets = out.get("targets")
    if not isinstance(targets, list):
        targets = []
    norm_t: list[dict[str, Any]] = []
    for t in targets:
        if isinstance(t, dict):
            norm_t.append(
                {"price": float(t.get("price", 0.0) or 0.0), "label": str(t.get("label", ""))}
            )
    while len(norm_t) < 3:
        norm_t.append({"price": 0.0, "label": f"T{len(norm_t) + 1}"})
    out["targets"] = norm_t[:3]
    out["conviction"] = max(0.0, min(1.0, float(out.get("conviction", 0.0) or 0.0)))
    out["action"] = str(out.get("action", "WAIT")).upper()
    out["direction"] = str(out.get("direction", "long")).lower()
    out["summary"] = str(out.get("summary", ""))
    out["why_now"] = str(out.get("why_now", ""))
    out["headline"] = str(out.get("headline") or "")
    out["why"] = str(out.get("why") or "")
    out["timeframe"] = str(out.get("timeframe", ""))
    out["risk_reward_ratio"] = float(out.get("risk_reward_ratio", 0.0) or 0.0)
    out["position_size_suggestion"] = str(out.get("position_size_suggestion", "small"))
    out["invalidation"] = str(out.get("invalidation", ""))
    for key in ("risks", "confidence_factors", "invalidation_conditions"):
        v = out.get(key)
        if not isinstance(v, list):
            out[key] = []
        else:
            out[key] = [str(x) for x in v]
    return out
