"""Ranking / lottery helpers for BUY signals (research 2026-07 follow-up #2).

Research 2026-07-20 findings:
- Conf=100: 16.7% win rate, −18.38% avg return (worst bucket)
- Conf 90–94: 60% win rate, +0.72% avg return (only profitable bucket)
- Conf 95–99: 25% win rate, −8.18% avg (poor)
- Conf 80–89: 20% win rate, −4.74% avg (poor)

This module now PENALIZES high confidence (≥98) and PRIORITIZES mid-tier confidence (90–94).
"""

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


def is_high_confidence_risk(
    confidence: float,
    *,
    high_confidence_risk_threshold: int,
) -> bool:
    """True for signals with dangerously high confidence (conf ≥ threshold).

    Research 2026-07-20: conf=100 had 16.7% win rate and −18.38% avg return.
    These signals are euphoria tops, not high-quality entries.
    """
    return confidence >= high_confidence_risk_threshold


def in_preferred_confidence_band(
    confidence: float,
    *,
    prefer_confidence_min: int,
    prefer_confidence_max: int,
) -> bool:
    """True for signals in the sweet-spot confidence range.

    Research 2026-07-20: conf 90–94 had 60% win rate and +0.72% avg return.
    """
    return prefer_confidence_min <= confidence <= prefer_confidence_max


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
    high_confidence_risk_threshold: int = 98,
    prefer_confidence_min: int = 90,
    prefer_confidence_max: int = 94,
) -> tuple[int, int, int, int, int, float, float, float]:
    """Sort key: BUY first, preferred confidence band, non-high-risk, preferred ret_5d band,
    non-lottery, then least overextended.

    Research 2026-07-20: conf=100 has worst performance (16.7% win, −18.38% avg).
    Conf 90–94 is the only profitable bucket (60% win, +0.72% avg).
    """
    action_rank = 0 if action == "BUY" else (1 if action == "SELL" else 2)

    # Confidence band ranking (new in 2026-07-20 follow-up #2)
    high_risk = is_high_confidence_risk(
        confidence,
        high_confidence_risk_threshold=high_confidence_risk_threshold,
    )
    preferred_conf = in_preferred_confidence_band(
        confidence,
        prefer_confidence_min=prefer_confidence_min,
        prefer_confidence_max=prefer_confidence_max,
    )

    lottery = is_lottery_setup(
        metrics,
        lottery_vol_ratio_min=lottery_vol_ratio_min,
        lottery_ret_5d_min_pct=lottery_ret_5d_min_pct,
    )
    preferred_ret = in_preferred_ret_5d_band(
        metrics,
        prefer_min_pct=prefer_min_pct,
        prefer_max_pct=prefer_max_pct,
    )
    ret_5d = _f(metrics, "ret_5d_pct")
    overextension = float(ret_5d) if ret_5d is not None else 999.0

    # Lower is better for each component after action_rank.
    # Priority order:
    # 1. Action (BUY first)
    # 2. NOT high-risk confidence (penalize conf ≥ 98)
    # 3. Preferred confidence band (prioritize conf 90–94)
    # 4. Preferred ret_5d band
    # 5. Non-lottery
    # 6. Least overextended (lower ret_5d)
    # 7. Higher score (tiebreaker)
    # 8. Higher confidence (final tiebreaker)
    return (
        action_rank,
        1 if high_risk else 0,           # Penalize high-risk conf (conf ≥ 98)
        0 if preferred_conf else 1,      # Prioritize preferred conf band (90–94)
        0 if preferred_ret else 1,       # Prioritize preferred ret_5d band
        1 if lottery else 0,             # Deprioritize lottery
        overextension,                   # Least overextended
        -float(score),
        -float(confidence),
    )


def annotate_buy_quality_flags(
    metrics: dict[str, Any],
    *,
    confidence: float,
    prefer_min_pct: float,
    prefer_max_pct: float,
    lottery_vol_ratio_min: float,
    lottery_ret_5d_min_pct: float,
    high_confidence_risk_threshold: int = 98,
    prefer_confidence_min: int = 90,
    prefer_confidence_max: int = 94,
) -> dict[str, Any]:
    """Return a shallow copy of metrics with lottery / preferred-band / confidence flags."""
    out = dict(metrics)
    lottery = is_lottery_setup(
        out,
        lottery_vol_ratio_min=lottery_vol_ratio_min,
        lottery_ret_5d_min_pct=lottery_ret_5d_min_pct,
    )
    preferred_ret = in_preferred_ret_5d_band(
        out,
        prefer_min_pct=prefer_min_pct,
        prefer_max_pct=prefer_max_pct,
    )
    high_risk = is_high_confidence_risk(
        confidence,
        high_confidence_risk_threshold=high_confidence_risk_threshold,
    )
    preferred_conf = in_preferred_confidence_band(
        confidence,
        prefer_confidence_min=prefer_confidence_min,
        prefer_confidence_max=prefer_confidence_max,
    )
    out["lottery_flag"] = lottery
    out["preferred_ret_5d_band"] = preferred_ret
    out["high_confidence_risk_flag"] = high_risk
    out["preferred_confidence_band"] = preferred_conf
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
        "high_confidence_risk_flag",
        "preferred_confidence_band",
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
    high_confidence_risk_threshold: int = 98,
    prefer_confidence_min: int = 90,
    prefer_confidence_max: int = 94,
) -> tuple[int, int, int, int, int, float, float, float]:
    """Rank key for a Firestore BUY row (same order as live scan ranking)."""
    try:
        conf = float(row.get("confidence") or 0.0)
    except (TypeError, ValueError):
        conf = 0.0
    m = metrics_from_firestore_row(row)
    if "lottery_flag" not in m or "high_confidence_risk_flag" not in m:
        m = annotate_buy_quality_flags(
            m,
            confidence=conf,
            prefer_min_pct=prefer_min_pct,
            prefer_max_pct=prefer_max_pct,
            lottery_vol_ratio_min=lottery_vol_ratio_min,
            lottery_ret_5d_min_pct=lottery_ret_5d_min_pct,
            high_confidence_risk_threshold=high_confidence_risk_threshold,
            prefer_confidence_min=prefer_confidence_min,
            prefer_confidence_max=prefer_confidence_max,
        )
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
        high_confidence_risk_threshold=high_confidence_risk_threshold,
        prefer_confidence_min=prefer_confidence_min,
        prefer_confidence_max=prefer_confidence_max,
    )
