"""Ranking / lottery helpers for BUY signals (research 2026-07 follow-up)."""

from __future__ import annotations

from typing import Any


def _f(metrics: dict[str, Any], key: str) -> float | None:
    v = metrics.get(key)
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def is_lottery_setup(
    metrics: dict[str, Any],
    *,
    lottery_vol_ratio_min: float,
    lottery_ret_5d_min_pct: float,
) -> bool:
    """True for extreme momentum / volume ignition names (binary lottery outcomes)."""
    if lottery_vol_ratio_min <= 0 and lottery_ret_5d_min_pct <= 0:
        return False
    ret_5d = _f(metrics, "ret_5d_pct")
    vol_ratio = _f(metrics, "vol_ratio")
    if lottery_ret_5d_min_pct > 0 and ret_5d is not None and ret_5d >= lottery_ret_5d_min_pct:
        return True
    if lottery_vol_ratio_min > 0 and vol_ratio is not None and vol_ratio >= lottery_vol_ratio_min:
        return True
    return False


def in_preferred_ret_5d_band(
    metrics: dict[str, Any],
    *,
    prefer_min_pct: float,
    prefer_max_pct: float,
) -> bool:
    ret_5d = _f(metrics, "ret_5d_pct")
    if ret_5d is None:
        return False
    return prefer_min_pct <= ret_5d <= prefer_max_pct


def buy_rank_key(
    *,
    action: str,
    confidence: float,
    score: float,
    metrics: dict[str, Any],
    prefer_min_pct: float,
    prefer_max_pct: float,
    lottery_vol_ratio_min: float,
    lottery_ret_5d_min_pct: float,
) -> tuple[int, int, int, float, float, float]:
    """Sort key: BUY first, preferred ret_5d band, non-lottery, then least overextended.

    Confidence is only a final tiebreaker (research: conf is not predictive).
    """
    action_rank = 0 if action == "BUY" else (1 if action == "SELL" else 2)
    lottery = is_lottery_setup(
        metrics,
        lottery_vol_ratio_min=lottery_vol_ratio_min,
        lottery_ret_5d_min_pct=lottery_ret_5d_min_pct,
    )
    preferred = in_preferred_ret_5d_band(
        metrics,
        prefer_min_pct=prefer_min_pct,
        prefer_max_pct=prefer_max_pct,
    )
    ret_5d = _f(metrics, "ret_5d_pct")
    overextension = float(ret_5d) if ret_5d is not None else 999.0
    # Lower is better for each component after action_rank.
    return (
        action_rank,
        0 if preferred else 1,
        1 if lottery else 0,
        overextension,
        -float(confidence),
        -float(score),
    )


def annotate_buy_quality_flags(
    metrics: dict[str, Any],
    *,
    prefer_min_pct: float,
    prefer_max_pct: float,
    lottery_vol_ratio_min: float,
    lottery_ret_5d_min_pct: float,
) -> dict[str, Any]:
    """Return a shallow copy of metrics with lottery / preferred-band flags."""
    out = dict(metrics)
    lottery = is_lottery_setup(
        out,
        lottery_vol_ratio_min=lottery_vol_ratio_min,
        lottery_ret_5d_min_pct=lottery_ret_5d_min_pct,
    )
    preferred = in_preferred_ret_5d_band(
        out,
        prefer_min_pct=prefer_min_pct,
        prefer_max_pct=prefer_max_pct,
    )
    out["lottery_flag"] = lottery
    out["preferred_ret_5d_band"] = preferred
    return out


def metrics_from_firestore_row(row: dict[str, Any]) -> dict[str, Any]:
    """Rebuild metrics dict from a Firestore signals[] BUY row."""
    raw = row.get("metrics")
    m: dict[str, Any] = dict(raw) if isinstance(raw, dict) else {}
    for key in (
        "ret_1d_pct",
        "ret_5d_pct",
        "ret_10d_pct",
        "atr_pct",
        "vol_ratio",
        "breakout_dist_pct",
        "lottery_flag",
        "preferred_ret_5d_band",
    ):
        if key in row and row[key] is not None:
            m[key] = row[key]
    return m


def buy_rank_key_from_row(
    row: dict[str, Any],
    *,
    prefer_min_pct: float,
    prefer_max_pct: float,
    lottery_vol_ratio_min: float,
    lottery_ret_5d_min_pct: float,
) -> tuple[int, int, int, float, float, float]:
    """Rank key for a Firestore BUY row (same order as live scan ranking)."""
    m = metrics_from_firestore_row(row)
    if "lottery_flag" not in m:
        m = annotate_buy_quality_flags(
            m,
            prefer_min_pct=prefer_min_pct,
            prefer_max_pct=prefer_max_pct,
            lottery_vol_ratio_min=lottery_vol_ratio_min,
            lottery_ret_5d_min_pct=lottery_ret_5d_min_pct,
        )
    try:
        conf = float(row.get("confidence") or 0.0)
    except (TypeError, ValueError):
        conf = 0.0
    raw_score = row.get("score")
    try:
        s = float(raw_score or 0.0)
        score = s if s > 1.0 + 1e-9 else s * 100.0
    except (TypeError, ValueError):
        score = 0.0
    return buy_rank_key(
        action="BUY",
        confidence=conf,
        score=score,
        metrics=m,
        prefer_min_pct=prefer_min_pct,
        prefer_max_pct=prefer_max_pct,
        lottery_vol_ratio_min=lottery_vol_ratio_min,
        lottery_ret_5d_min_pct=lottery_ret_5d_min_pct,
    )
