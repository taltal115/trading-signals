"""§5 total score formula."""

from __future__ import annotations

from typing import Any

DEFAULT_WEIGHTS: dict[str, float] = {
    "price_strength": 10.0,
    "gap_strength": 8.0,
    "relative_strength": 10.0,
    "relative_volume": 10.0,
    "volume_strength": 6.0,
    "catalyst_strength": 10.0,
    "event_timing_score": 8.0,
    "sentiment_intensity": 10.0,
    "ticker_news_relevance": 10.0,
    "liquidity_ok": 8.0,
}


def normalize_score(x: float) -> float:
    return max(0.0, min(100.0, x))


def deterministic_raw_sum(features: dict[str, float]) -> float:
    total = 0.0
    for name, w in DEFAULT_WEIGHTS.items():
        total += float(features.get(name, 0.0)) * w
    return total


def strategy_component_value(strategy_results: dict[str, dict[str, Any]], best_strategy: str) -> float:
    if not strategy_results:
        return 0.0
    weight_sum = 0.0
    weighted = 0.0
    for name, result in strategy_results.items():
        s = float(result.get("score", 0.0))
        w = 2.0 if name == best_strategy else 1.0
        weighted += s * w
        weight_sum += w
    if weight_sum <= 0:
        return 0.0
    strategy_avg = weighted / weight_sum
    return strategy_avg * 20.0


def compute_total_score(
    *,
    features: dict[str, float],
    strategy_results: dict[str, dict[str, Any]],
    best_strategy: str,
    conviction: float,
) -> tuple[float, dict[str, float]]:
    """Returns (total 0–100, breakdown of raw components before final clamp)."""
    det_raw = deterministic_raw_sum(features)
    strat_c = strategy_component_value(strategy_results, best_strategy)
    technical = float(features.get("technical_score", 0.0))
    ai_c = float(conviction) * 16.0
    tech_c = technical * 0.14
    raw_total = det_raw + strat_c + ai_c + tech_c
    total = normalize_score(raw_total)
    breakdown = {
        "deterministic_raw": det_raw,
        "strategy_component": strat_c,
        "ai_component": ai_c,
        "technical_component": tech_c,
        "raw_total": raw_total,
        "total": total,
    }
    return total, breakdown
