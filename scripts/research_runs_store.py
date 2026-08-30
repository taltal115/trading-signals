"""Firestore persistence for UI / GHA profit-hold research runs."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

from signals_bot.storage.firestore import RESEARCH_RUNS_COLLECTION, get_firestore_client


def make_run_id(ts: datetime | None = None) -> str:
    now = ts or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    # Firestore-friendly id (no dots/colons issues in some tools)
    return now.strftime("%Y-%m-%dT%H-%M-%S.%f")[:-3] + "Z"


def sanitize_for_firestore(value: Any) -> Any:
    """Replace inf/nan; recurse into dict/list for Firestore JSON safety."""
    if isinstance(value, float):
        if math.isinf(value) or math.isnan(value):
            return None
        return value
    if isinstance(value, dict):
        return {str(k): sanitize_for_firestore(v) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize_for_firestore(v) for v in value]
    if isinstance(value, tuple):
        return [sanitize_for_firestore(v) for v in value]
    return value


def upsert_research_run(run_id: str, data: dict[str, Any]) -> str:
    db = get_firestore_client()
    rid = str(run_id).strip()
    if not rid:
        raise ValueError("run_id required")
    payload = sanitize_for_firestore(dict(data))
    payload["id"] = rid
    payload["updated_at_utc"] = datetime.now(timezone.utc).isoformat()
    db.collection(RESEARCH_RUNS_COLLECTION).document(rid).set(payload, merge=True)
    return rid


def get_research_run(run_id: str) -> dict[str, Any] | None:
    db = get_firestore_client()
    snap = db.collection(RESEARCH_RUNS_COLLECTION).document(str(run_id).strip()).get()
    if not snap.exists:
        return None
    data = snap.to_dict() or {}
    data["id"] = snap.id
    return data


def list_research_runs(*, limit: int = 30) -> list[dict[str, Any]]:
    db = get_firestore_client()
    q = (
        db.collection(RESEARCH_RUNS_COLLECTION)
        .order_by("created_at_utc", direction="DESCENDING")
        .limit(max(1, min(int(limit), 100)))
    )
    out: list[dict[str, Any]] = []
    for snap in q.stream():
        row = snap.to_dict() or {}
        row["id"] = snap.id
        out.append(row)
    return out


def latest_succeeded_run() -> dict[str, Any] | None:
    """Newest succeeded run (no composite index: scan recent by created_at)."""
    for row in list_research_runs(limit=40):
        if str(row.get("status") or "") == "succeeded":
            return row
    return None
