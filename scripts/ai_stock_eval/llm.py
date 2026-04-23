"""OpenAI chat completions (JSON mode) or WAIT stub without API key."""

from __future__ import annotations

import json
import os
from typing import Any

import requests

DEFAULT_MODEL = "gpt-4.1"
DEFAULT_BASE = "https://api.openai.com/v1"


def _stub_verdict() -> dict[str, Any]:
    return {
        "action": "WAIT",
        "conviction": 0.5,
        "direction": "long",
        "summary": "No API key configured; stub evaluation.",
        "why_now": "Set OPENAI_API_KEY to enable model evaluation.",
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
    }


def call_openai_json(*, system: str, user: str, model: str | None = None) -> tuple[dict[str, Any], str]:
    """Returns (parsed_json, source) where source is 'openai' or 'stub'."""
    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        return _stub_verdict(), "stub"

    base = (os.getenv("OPENAI_BASE_URL") or DEFAULT_BASE).rstrip("/")
    m = model or os.getenv("OPENAI_MODEL") or DEFAULT_MODEL
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
    return parsed, "openai"


def normalize_verdict(raw: dict[str, Any]) -> dict[str, Any]:
    """Fill defaults for §4 schema."""
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
