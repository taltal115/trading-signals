"""Build and merge ``pipeline_trace`` on Firestore BUY / AI entry rows."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


PIPELINE_TRACE_VERSION = 1


def _f(metrics: dict[str, Any], key: str) -> float | None:
    v = metrics.get(key)
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def strategy_thresholds_snapshot(strategy: Any) -> dict[str, Any]:
    """Snapshot strategy + AI gate knobs used for this write."""
    ai = getattr(strategy, "ai", None)  # rarely passed; callers may merge
    out: dict[str, Any] = {
        "continuation_ret_5d_min_pct": float(
            getattr(strategy, "continuation_ret_5d_min_pct", 8.0)
        ),
        "continuation_ret_5d_max_pct": float(
            getattr(strategy, "continuation_ret_5d_max_pct", 25.0)
        ),
        "continuation_vol_ratio_min": float(
            getattr(strategy, "continuation_vol_ratio_min", 2.0)
        ),
        "continuation_vol_ratio_max": float(
            getattr(strategy, "continuation_vol_ratio_max", 4.0)
        ),
        "hard_reject_ret_5d_min_pct": float(
            getattr(strategy, "hard_reject_ret_5d_min_pct", 50.0)
        ),
        "hard_reject_vol_ratio_min": float(
            getattr(strategy, "hard_reject_vol_ratio_min", 5.0)
        ),
        "hard_reject_confidence_min": int(
            getattr(strategy, "hard_reject_confidence_min", 0)
        ),
        "require_continuation_band": bool(
            getattr(strategy, "require_continuation_band", True)
        ),
        "ret_5d_min_pct": float(getattr(strategy, "ret_5d_min_pct", 8.0)),
        "ret_10d_min_pct": float(getattr(strategy, "ret_10d_min_pct", 12.0)),
        "vol_ratio_min": float(getattr(strategy, "vol_ratio_min", 2.0)),
        "min_buy_confidence": int(getattr(strategy, "min_buy_confidence", 70)),
    }
    if ai is not None:
        out["entry_min_total"] = float(getattr(ai, "entry_min_total", 70.0))
        out["entry_min_conviction"] = float(getattr(ai, "entry_min_conviction", 0.7))
    return out


def build_scan_pipeline_trace(
    *,
    confidence: float,
    metrics: dict[str, Any],
    notes: str,
    strategy: Any,
    ai: Any | None = None,
    at_utc: str | None = None,
) -> dict[str, Any]:
    """Initial ``pipeline_trace`` written with technical BUY rows."""
    m = metrics or {}
    ret5 = _f(m, "ret_5d_pct")
    ret10 = _f(m, "ret_10d_pct")
    vol = _f(m, "vol_ratio")
    thr = strategy_thresholds_snapshot(strategy)
    if ai is not None:
        thr["entry_min_total"] = float(getattr(ai, "entry_min_total", 70.0))
        thr["entry_min_conviction"] = float(getattr(ai, "entry_min_conviction", 0.7))
    else:
        thr.setdefault("entry_min_total", 70.0)
        thr.setdefault("entry_min_conviction", 0.7)

    ret5_min = float(thr["ret_5d_min_pct"])
    ret10_min = float(thr["ret_10d_min_pct"])
    vol_min = float(thr["vol_ratio_min"])
    conf_min = int(thr["min_buy_confidence"])
    lot_ret = float(thr["hard_reject_ret_5d_min_pct"])
    lot_vol = float(thr["hard_reject_vol_ratio_min"])
    band_ret_lo = float(thr["continuation_ret_5d_min_pct"])
    band_ret_hi = float(thr["continuation_ret_5d_max_pct"])
    band_vol_lo = float(thr["continuation_vol_ratio_min"])
    band_vol_hi = float(thr["continuation_vol_ratio_max"])
    require_band = bool(thr["require_continuation_band"])

    scan_conditions = [
        {
            "id": "momentum_5d",
            "label": "ret_5d ≥ min",
            "pass": ret5 is not None and ret5 >= ret5_min,
            "actual": ret5,
            "threshold": ret5_min,
        },
        {
            "id": "momentum_10d",
            "label": "ret_10d ≥ min",
            "pass": ret10 is not None and ret10 >= ret10_min,
            "actual": ret10,
            "threshold": ret10_min,
        },
        {
            "id": "volume",
            "label": "vol_ratio ≥ min",
            "pass": vol is not None and vol >= vol_min,
            "actual": vol,
            "threshold": vol_min,
        },
        {
            "id": "min_confidence",
            "label": "confidence ≥ min_buy_confidence",
            "pass": float(confidence) >= conf_min,
            "actual": float(confidence),
            "threshold": conf_min,
            "detail": notes or "",
        },
    ]

    hard_conditions = [
        {
            "id": "not_lottery_ret",
            "label": f"ret_5d < {lot_ret:g}% (lottery)",
            "pass": ret5 is None or ret5 < lot_ret,
            "actual": ret5,
            "threshold": lot_ret,
        },
        {
            "id": "not_lottery_vol",
            "label": f"vol < {lot_vol:g}× (lottery)",
            "pass": vol is None or vol < lot_vol,
            "actual": vol,
            "threshold": lot_vol,
        },
        {
            "id": "continuation_ret",
            "label": f"ret_5d in [{band_ret_lo:g}, {band_ret_hi:g}]",
            "pass": (not require_band)
            or (ret5 is not None and band_ret_lo <= ret5 <= band_ret_hi),
            "actual": ret5,
            "threshold": f"[{band_ret_lo:g},{band_ret_hi:g}]",
        },
        {
            "id": "continuation_vol",
            "label": f"vol in [{band_vol_lo:g}, {band_vol_hi:g})",
            "pass": (not require_band)
            or (vol is not None and band_vol_lo <= vol < band_vol_hi),
            "actual": vol,
            "threshold": f"[{band_vol_lo:g},{band_vol_hi:g})",
        },
    ]

    ts = at_utc or datetime.now(timezone.utc).isoformat()
    return {
        "version": PIPELINE_TRACE_VERSION,
        "thresholds": thr,
        "stages": {
            "scan": {
                "at_utc": ts,
                "job": "breakout-scan",
                "status": "passed",
                "conditions": scan_conditions,
            },
            "hard_filters": {
                "at_utc": ts,
                "job": "breakout-scan",
                "status": "passed",
                "conditions": hard_conditions,
            },
        },
    }


def merge_pipeline_trace_stage(
    existing: dict[str, Any] | None,
    *,
    stage_id: str,
    status: str,
    conditions: list[dict[str, Any]] | None = None,
    detail: dict[str, Any] | None = None,
    thresholds_patch: dict[str, Any] | None = None,
    job: str | None = None,
    at_utc: str | None = None,
) -> dict[str, Any]:
    """Append/replace one stage on an existing ``pipeline_trace``."""
    base: dict[str, Any] = dict(existing) if isinstance(existing, dict) else {}
    base["version"] = int(base.get("version") or PIPELINE_TRACE_VERSION)
    thr = dict(base.get("thresholds") or {})
    if thresholds_patch:
        thr.update(thresholds_patch)
    base["thresholds"] = thr
    stages = dict(base.get("stages") or {})
    stage: dict[str, Any] = {
        "at_utc": at_utc or datetime.now(timezone.utc).isoformat(),
        "status": status,
    }
    if job:
        stage["job"] = job
    if conditions is not None:
        stage["conditions"] = conditions
    if detail:
        stage["detail"] = detail
    stages[stage_id] = stage
    base["stages"] = stages
    return base
