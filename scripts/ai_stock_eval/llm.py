"""OpenAI chat completions (JSON mode) or WAIT stub without API key."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

import requests

DEFAULT_MODEL = "gpt-5.4"
DEFAULT_BASE = "https://api.openai.com/v1"


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
    resp = requests.post(url, headers=headers, json=body, timeout=120)
    resp.raise_for_status()
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
