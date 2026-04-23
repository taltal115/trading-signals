"""Persist AI evaluation to Firestore (position doc or signals doc)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from google.cloud import firestore

from signals_bot.storage.firestore import get_firestore_client


def read_candidate_score(db: firestore.Client, signal_doc_id: str, ticker: str) -> float:
    """Return signal row `score` (0–1) * 100 for candidate_score, or 0.0."""
    sym = ticker.strip().upper()
    ref = db.collection("signals").document(signal_doc_id)
    snap = ref.get()
    if not snap.exists:
        return 0.0
    data = snap.to_dict() or {}
    arr = data.get("signals")
    if not isinstance(arr, list):
        return 0.0
    for item in arr:
        if not isinstance(item, dict):
            continue
        if str(item.get("ticker", "")).strip().upper() != sym:
            continue
        raw = item.get("score")
        try:
            s = float(raw)
            return s * 100.0 if s <= 1.0 + 1e-9 else s
        except (TypeError, ValueError):
            return 0.0
    return 0.0


def write_evaluation(
    *,
    ticker: str,
    signal_doc_id: str,
    position_id: str | None,
    owner_uid: str | None,
    payload: dict[str, Any],
) -> None:
    db = get_firestore_client()
    sym = ticker.strip().upper()
    if position_id and owner_uid:
        pref = db.collection("my_positions").document(position_id)
        psnap = pref.get()
        if not psnap.exists:
            raise RuntimeError(f"Position not found: {position_id}")
        pdata = psnap.to_dict() or {}
        if pdata.get("owner_uid") != owner_uid:
            raise RuntimeError("Position owner_uid mismatch")
        pref.update({"ai_evaluation": payload})
        return

    sref = db.collection("signals").document(signal_doc_id)
    ssnap = sref.get()
    if not ssnap.exists:
        raise RuntimeError(f"Signals document not found: {signal_doc_id}")
    prev = ssnap.to_dict() or {}
    ae = dict(prev.get("ai_evaluations") or {})
    ae[sym] = payload
    sref.update({"ai_evaluations": ae})


def build_payload(
    *,
    ticker: str,
    signal_doc_id: str,
    total: float,
    conviction: float,
    verdict: dict[str, Any],
    breakdown: dict[str, float],
    source: str,
) -> dict[str, Any]:
    return {
        "evaluated_at_utc": datetime.now(timezone.utc).isoformat(),
        "ticker": ticker.strip().upper(),
        "signal_doc_id": signal_doc_id,
        "total": float(total),
        "conviction": float(conviction),
        "verdict": verdict,
        "breakdown": {k: float(v) for k, v in breakdown.items()},
        "source": source,
    }
