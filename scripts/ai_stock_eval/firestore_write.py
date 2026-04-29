"""Persist AI evaluation to Firestore (nested under signals[] on the run doc)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from google.cloud import firestore

from signals_bot.storage.firestore import MY_POSITIONS_COLLECTION, SIGNALS_COLLECTION, get_firestore_client


def resolve_signals_run_ref(db: firestore.Client, doc_id: str) -> firestore.DocumentReference:
    """Return the run document ref in ``signals``."""
    did = doc_id.strip()
    ref = db.collection(SIGNALS_COLLECTION).document(did)
    if not ref.get().exists:
        raise RuntimeError(
            f"No signals run document for id={doc_id!r} in collection {SIGNALS_COLLECTION!r}"
        )
    return ref


def read_candidate_score(db: firestore.Client, signal_doc_id: str, ticker: str) -> float:
    """Return signal row `score` (0–1) * 100 for candidate_score, or 0.0."""
    sym = ticker.strip().upper()
    did = signal_doc_id.strip()
    snap = db.collection(SIGNALS_COLLECTION).document(did).get()
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


def _merge_ai_evaluation_transaction(
    db: firestore.Client,
    run_ref: firestore.DocumentReference,
    ticker: str,
    payload: dict[str, Any],
) -> None:
    sym = ticker.strip().upper()

    @firestore.transactional
    def _do(transaction, ref):  # type: ignore[no-untyped-def]
        snap = ref.get(transaction=transaction)
        if not snap.exists:
            raise RuntimeError(f"Signals run document missing: {ref.id}")
        data = snap.to_dict() or {}
        sigs = data.get("signals")
        if not isinstance(sigs, list):
            raise RuntimeError("Run document has no signals[] array")
        new_sigs: list[Any] = []
        found = False
        for row in sigs:
            if not isinstance(row, dict):
                new_sigs.append(row)
                continue
            r = dict(row)
            if str(r.get("ticker", "")).strip().upper() == sym:
                r["ai_evaluation"] = payload
                found = True
            new_sigs.append(r)
        if not found:
            raise RuntimeError(
                f"Ticker {sym!r} not found in signals[] for document {ref.id!r}"
            )
        transaction.update(ref, {"signals": new_sigs})

    txn = db.transaction()
    _do(txn, run_ref)


def write_evaluation(
    *,
    ticker: str,
    signal_doc_id: str,
    position_id: str | None,
    owner_uid: str | None,
    payload: dict[str, Any],
) -> None:
    db = get_firestore_client()
    run_ref = resolve_signals_run_ref(db, signal_doc_id)

    if position_id and owner_uid:
        pref = db.collection(MY_POSITIONS_COLLECTION).document(position_id)
        psnap = pref.get()
        if not psnap.exists:
            raise RuntimeError(f"Position not found: {position_id}")
        pdata = psnap.to_dict() or {}
        if pdata.get("owner_uid") != owner_uid:
            raise RuntimeError("Position owner_uid mismatch")
        pref.update({"ai_evaluation": payload})

    _merge_ai_evaluation_transaction(db, run_ref, ticker, payload)


def build_ai_evaluation_record(
    *,
    ticker: str,
    signal_doc_id: str,
    provider_status: dict[str, bool],
    scores: dict[str, Any],
    prompt: dict[str, str],
    llm: dict[str, Any],
    verify: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Single object stored as ``signals[i].ai_evaluation`` and on position rows ``ai_evaluation``."""
    out: dict[str, Any] = {
        "evaluated_at_utc": datetime.now(timezone.utc).isoformat(),
        "ticker": ticker.strip().upper(),
        "signal_doc_id": signal_doc_id.strip(),
        "provider_status": dict(provider_status),
        "scores": scores,
        "prompt": dict(prompt),
        "llm": dict(llm),
    }
    if verify is not None:
        out["verify"] = verify
    return out
