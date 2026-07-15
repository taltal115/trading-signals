"""Build clear recommendation object from LLM verdict + scores."""

from __future__ import annotations

from typing import Any


def _hold_days_from_verdict(verdict: dict[str, Any], default: int = 3) -> int:
    raw = verdict.get("hold_days")
    if raw is not None:
        try:
            return max(1, min(10, int(raw)))
        except (TypeError, ValueError):
            pass
    tf = str(verdict.get("timeframe") or "").lower()
    if "1-3" in tf or "1–3" in tf:
        return 3
    if "3-5" in tf or "3–5" in tf:
        return 5
    if "week" in tf:
        return 7
    return default


def _risk_level(verdict: dict[str, Any], conviction: float) -> str:
    explicit = str(verdict.get("risk_level") or "").strip().lower()
    if explicit in ("low", "medium", "high"):
        return explicit
    rr = float(verdict.get("risk_reward_ratio") or 0.0)
    if conviction >= 0.75 and rr >= 2.0:
        return "low"
    if conviction < 0.5 or rr < 1.5:
        return "high"
    return "medium"


def _risk_score(verdict: dict[str, Any], conviction: float) -> int:
    raw = verdict.get("risk_score")
    if raw is not None:
        try:
            return max(0, min(100, int(float(raw))))
        except (TypeError, ValueError):
            pass
    level = _risk_level(verdict, conviction)
    return {"low": 25, "medium": 55, "high": 80}[level]


def _checklist(verdict: dict[str, Any]) -> list[dict[str, Any]]:
    raw = verdict.get("checklist")
    out: list[dict[str, Any]] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            out.append(
                {
                    "id": str(item.get("id") or ""),
                    "label": str(item.get("label") or ""),
                    "pass": bool(item.get("pass")),
                }
            )
    if out:
        return out
    rr = float(verdict.get("risk_reward_ratio") or 0.0)
    action = str(verdict.get("action") or "WAIT").upper()
    return [
        {"id": "rr", "label": "Risk/reward >= 2", "pass": rr >= 2.0},
        {"id": "action", "label": "Model says BUY", "pass": action == "BUY"},
    ]


def build_recommendation(
    *,
    verdict: dict[str, Any],
    scores: dict[str, Any],
    technical_score: float,
) -> dict[str, Any]:
    conviction = float(verdict.get("conviction") or 0.0)
    ez = verdict.get("entry_zone") if isinstance(verdict.get("entry_zone"), dict) else {}
    targets = verdict.get("targets") if isinstance(verdict.get("targets"), list) else []
    t1 = 0.0
    for t in targets:
        if isinstance(t, dict) and str(t.get("label", "")).upper() in ("T1", "T2", ""):
            try:
                t1 = float(t.get("price") or 0.0)
            except (TypeError, ValueError):
                t1 = 0.0
            if str(t.get("label", "")).upper() == "T2" and t1 > 0:
                break
            if str(t.get("label", "")).upper() == "T1":
                break
    if t1 <= 0 and targets:
        t0 = targets[0]
        if isinstance(t0, dict):
            try:
                t1 = float(t0.get("price") or 0.0)
            except (TypeError, ValueError):
                t1 = 0.0

    headline = str(verdict.get("headline") or "").strip()
    if not headline:
        headline = str(verdict.get("summary") or "").strip().split(".")[0][:160] or "No headline"

    why = str(verdict.get("why") or verdict.get("why_now") or "").strip()
    decision = str(verdict.get("action") or "WAIT").upper()
    if decision not in ("BUY", "WAIT", "AVOID"):
        decision = "WAIT"

    total = float(scores.get("total") or 0.0)
    ai_pts = float((scores.get("breakdown") or {}).get("ai_component") or conviction * 16.0)

    return {
        "decision": decision,
        "headline": headline,
        "why": why,
        "risk_level": _risk_level(verdict, conviction),
        "risk_score": _risk_score(verdict, conviction),
        "scores": {
            "technical": round(float(technical_score), 2),
            "ai": round(ai_pts, 2),
            "total": round(total, 2),
        },
        "plan": {
            "entry": {
                "ideal": float(ez.get("ideal_price") or 0.0),
                "min": float(ez.get("min_price") or 0.0),
                "max": float(ez.get("max_price") or 0.0),
            },
            "stop": float(verdict.get("stop_loss") or 0.0),
            "target": t1,
            "hold_days": _hold_days_from_verdict(verdict),
            "invalidation": str(verdict.get("invalidation") or ""),
        },
        "checklist": _checklist(verdict),
        "detail": {
            "conviction": conviction,
            "direction": str(verdict.get("direction") or "long"),
            "summary": str(verdict.get("summary") or ""),
            "why_now": str(verdict.get("why_now") or ""),
            "timeframe": str(verdict.get("timeframe") or ""),
            "risk_reward_ratio": float(verdict.get("risk_reward_ratio") or 0.0),
            "position_size_suggestion": str(verdict.get("position_size_suggestion") or "small"),
            "risks": list(verdict.get("risks") or []),
            "confidence_factors": list(verdict.get("confidence_factors") or []),
            "invalidation_conditions": list(verdict.get("invalidation_conditions") or []),
            "targets": targets,
        },
    }


def resolve_ai_gate(
    *,
    recommendation: dict[str, Any],
    conviction: float,
    entry_min_total: float,
    entry_min_conviction: float,
) -> str:
    decision = str(recommendation.get("decision") or "WAIT").upper()
    total = float((recommendation.get("scores") or {}).get("total") or 0.0)
    if (
        decision == "BUY"
        and total >= float(entry_min_total)
        and float(conviction) >= float(entry_min_conviction)
    ):
        return "passed"
    return "filtered"
