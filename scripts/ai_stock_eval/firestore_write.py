"""Persist AI evaluation: latest on signals[] row + append-only ai_evals."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from google.cloud import firestore

from signals_bot.storage.firestore import (
    MY_POSITIONS_COLLECTION,
    SIGNALS_COLLECTION,
    get_firestore_client,
    mirror_holding_advice_to_signal,
    upsert_signal_paper_position,
)

AI_EVALS_COLLECTION = "ai_evals"


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


def list_pending_tickers(db: firestore.Client, signal_doc_id: str) -> list[tuple[str, int, float]]:
    """Return [(ticker, index, candidate_score_0_100), ...] for rows needing entry AI."""
    snap = db.collection(SIGNALS_COLLECTION).document(signal_doc_id.strip()).get()
    if not snap.exists:
        return []
    data = snap.to_dict() or {}
    arr = data.get("signals")
    if not isinstance(arr, list):
        return []
    out: list[tuple[str, int, float]] = []
    for i, item in enumerate(arr):
        if not isinstance(item, dict):
            continue
        ticker = str(item.get("ticker") or "").strip().upper()
        if not ticker:
            continue
        gate = str(item.get("ai_gate") or "pending").strip().lower()
        if gate not in ("pending", ""):
            # Re-eval only pending; already evaluated stay unless forced
            continue
        raw = item.get("score")
        try:
            s = float(raw)
            cand = s * 100.0 if s <= 1.0 + 1e-9 else s
        except (TypeError, ValueError):
            cand = 0.0
        out.append((ticker, i, cand))
    return out


def latest_signal_doc_id(db: firestore.Client) -> str | None:
    """Best-effort: newest signals run by ts_utc field (may need composite index-free scan)."""
    docs = (
        db.collection(SIGNALS_COLLECTION)
        .order_by("ts_utc", direction=firestore.Query.DESCENDING)
        .limit(1)
        .stream()
    )
    for d in docs:
        return d.id
    return None


def _utc_compact(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def make_eval_id(*, signal_doc_id: str, ticker: str, stage: str, ts: datetime) -> str:
    sid = signal_doc_id.strip().replace("/", "_")
    return f"{sid}__{ticker.strip().upper()}__{stage}__{_utc_compact(ts)}"


def _ai_summary_from_usage(
    *,
    eval_id: str,
    stage: str,
    decision: str,
    usage_model: str,
    prompt_tokens: int,
    completion_tokens: int,
    total_tokens: int,
    estimated_cost_usd: float | None,
    cost_estimated: bool,
    eval_count: int,
    ts_utc: str,
) -> dict[str, Any]:
    return {
        "has_eval": True,
        "eval_count": int(eval_count),
        "last_eval_id": eval_id,
        "last_at_utc": ts_utc,
        "last_stage": stage,
        "last_decision": decision,
        "model": usage_model,
        "prompt_tokens": int(prompt_tokens),
        "completion_tokens": int(completion_tokens),
        "total_tokens": int(total_tokens),
        "estimated_cost_usd": estimated_cost_usd,
        "cost_estimated": bool(cost_estimated),
    }


def write_entry_evaluation(
    *,
    ticker: str,
    signal_doc_id: str,
    position_id: str | None,
    owner_uid: str | None,
    recommendation: dict[str, Any],
    ai_gate: str,
    stage: str,
    usage: Any,
    detail: dict[str, Any] | None = None,
    apply_plan_overrides: bool = True,
) -> str:
    """Dual-write latest on signal row + append ai_evals. Returns eval_id."""
    db = get_firestore_client()
    run_ref = resolve_signals_run_ref(db, signal_doc_id)
    sym = ticker.strip().upper()
    now = datetime.now(timezone.utc)
    ts_utc = now.isoformat()
    eval_id = make_eval_id(signal_doc_id=signal_doc_id, ticker=sym, stage=stage, ts=now)
    decision = str(recommendation.get("decision") or recommendation.get("advice") or "")

    prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
    completion_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
    total_tokens = int(getattr(usage, "total_tokens", 0) or 0)
    model = str(getattr(usage, "model", "") or "")
    estimated_cost_usd = getattr(usage, "estimated_cost_usd", None)
    cost_estimated = bool(getattr(usage, "cost_estimated", False))

    signal_index = -1
    merged_row: dict[str, Any] | None = None

    @firestore.transactional
    def _merge(transaction, ref):  # type: ignore[no-untyped-def]
        nonlocal signal_index, merged_row
        snap = ref.get(transaction=transaction)
        if not snap.exists:
            raise RuntimeError(f"Signals run document missing: {ref.id}")
        data = snap.to_dict() or {}
        sigs = data.get("signals")
        if not isinstance(sigs, list):
            raise RuntimeError("Run document has no signals[] array")
        new_sigs: list[Any] = []
        found = False
        for i, row in enumerate(sigs):
            if not isinstance(row, dict):
                new_sigs.append(row)
                continue
            r = dict(row)
            if str(r.get("ticker", "")).strip().upper() != sym:
                new_sigs.append(r)
                continue
            found = True
            signal_index = i
            prev_ai = r.get("ai") if isinstance(r.get("ai"), dict) else {}
            prev_count = int(prev_ai.get("eval_count") or 0)
            eval_count = prev_count + 1
            r["ai_gate"] = ai_gate
            r["recommendation"] = recommendation
            r["ai"] = _ai_summary_from_usage(
                eval_id=eval_id,
                stage=stage,
                decision=decision,
                usage_model=model,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                estimated_cost_usd=estimated_cost_usd,
                cost_estimated=cost_estimated,
                eval_count=eval_count,
                ts_utc=ts_utc,
            )
            r["ai_evaluation"] = {
                "evaluated_at_utc": ts_utc,
                "ticker": sym,
                "signal_doc_id": signal_doc_id.strip(),
                "scores": recommendation.get("scores"),
                "llm": {"verdict": {"action": decision}, "source": getattr(usage, "source", "")},
            }
            if apply_plan_overrides and ai_gate == "passed":
                plan = recommendation.get("plan") if isinstance(recommendation.get("plan"), dict) else {}
                stop = plan.get("stop")
                target = plan.get("target")
                hold_days = plan.get("hold_days")
                close = float(r.get("close") or 0.0)
                if stop is not None and float(stop) > 0:
                    r["stop"] = float(stop)
                    if close > 0:
                        r["stop_pct"] = round((float(stop) - close) / close * 100.0, 4)
                if target is not None and float(target) > 0:
                    r["target"] = float(target)
                    if close > 0:
                        r["target_pct"] = round((float(target) - close) / close * 100.0, 4)
                if hold_days is not None:
                    try:
                        r["hold_days"] = int(hold_days)
                    except (TypeError, ValueError):
                        pass
            merged_row = dict(r)
            new_sigs.append(r)
        if not found:
            raise RuntimeError(
                f"Ticker {sym!r} not found in signals[] for document {ref.id!r}"
            )
        transaction.update(ref, {"signals": new_sigs})

    txn = db.transaction()
    _merge(txn, run_ref)

    paper_id: str | None = None
    if merged_row is not None:
        paper_id = upsert_signal_paper_position(
            db=db,
            signal_doc_id=signal_doc_id.strip(),
            signal_row=merged_row,
        )

        @firestore.transactional
        def _stamp(transaction, ref):  # type: ignore[no-untyped-def]
            snap = ref.get(transaction=transaction)
            if not snap.exists:
                return
            data = snap.to_dict() or {}
            sigs = data.get("signals")
            if not isinstance(sigs, list):
                return
            new_sigs: list[Any] = []
            for row in sigs:
                if not isinstance(row, dict):
                    new_sigs.append(row)
                    continue
                r = dict(row)
                if str(r.get("ticker", "")).strip().upper() == sym:
                    r["paper_position_id"] = paper_id
                    r["paper_status"] = r.get("paper_status") or "open"
                new_sigs.append(r)
            transaction.update(ref, {"signals": new_sigs})

        _stamp(db.transaction(), run_ref)

    eval_doc: dict[str, Any] = {
        "eval_id": eval_id,
        "ts_utc": ts_utc,
        "stage": stage,
        "ticker": sym,
        "signal_doc_id": signal_doc_id.strip(),
        "signal_index": signal_index,
        "position_id": position_id or paper_id,
        "model": model,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "estimated_cost_usd": estimated_cost_usd,
        "cost_estimated": cost_estimated,
        "decision": decision,
        "ai_gate": ai_gate,
        "recommendation": recommendation,
        "detail": detail or {},
        "llm_source": getattr(usage, "source", ""),
    }
    db.collection(AI_EVALS_COLLECTION).document(eval_id).set(eval_doc)

    if position_id and owner_uid:
        pref = db.collection(MY_POSITIONS_COLLECTION).document(position_id)
        psnap = pref.get()
        if not psnap.exists:
            raise RuntimeError(f"Position not found: {position_id}")
        pdata = psnap.to_dict() or {}
        if pdata.get("owner_uid") != owner_uid:
            raise RuntimeError("Position owner_uid mismatch")
        prev_ai = pdata.get("ai") if isinstance(pdata.get("ai"), dict) else {}
        eval_count = int(prev_ai.get("eval_count") or 0) + 1
        pref.update(
            {
                "recommendation": recommendation,
                "ai": _ai_summary_from_usage(
                    eval_id=eval_id,
                    stage=stage,
                    decision=decision,
                    usage_model=model,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=total_tokens,
                    estimated_cost_usd=estimated_cost_usd,
                    cost_estimated=cost_estimated,
                    eval_count=eval_count,
                    ts_utc=ts_utc,
                ),
            }
        )

    return eval_id


def write_holding_evaluation(
    *,
    ticker: str,
    position_id: str,
    owner_uid: str | None,
    advice: dict[str, Any],
    usage: Any,
    signal_doc_id: str = "",
    detail: dict[str, Any] | None = None,
) -> str:
    """Write holding advice on position + ai_evals history."""
    db = get_firestore_client()
    sym = ticker.strip().upper()
    now = datetime.now(timezone.utc)
    ts_utc = now.isoformat()
    stage = "holding"
    sid = (signal_doc_id or position_id).strip()
    eval_id = make_eval_id(signal_doc_id=sid, ticker=sym, stage=stage, ts=now)
    decision = str(advice.get("advice") or "")

    prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
    completion_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
    total_tokens = int(getattr(usage, "total_tokens", 0) or 0)
    model = str(getattr(usage, "model", "") or "")
    estimated_cost_usd = getattr(usage, "estimated_cost_usd", None)
    cost_estimated = bool(getattr(usage, "cost_estimated", False))

    pref = db.collection(MY_POSITIONS_COLLECTION).document(position_id)
    psnap = pref.get()
    if not psnap.exists:
        raise RuntimeError(f"Position not found: {position_id}")
    pdata = psnap.to_dict() or {}
    if owner_uid and pdata.get("owner_uid") != owner_uid:
        raise RuntimeError("Position owner_uid mismatch")

    prev_ai = pdata.get("ai") if isinstance(pdata.get("ai"), dict) else {}
    eval_count = int(prev_ai.get("eval_count") or 0) + 1
    ai_summary = _ai_summary_from_usage(
        eval_id=eval_id,
        stage=stage,
        decision=decision,
        usage_model=model,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
        estimated_cost_usd=estimated_cost_usd,
        cost_estimated=cost_estimated,
        eval_count=eval_count,
        ts_utc=ts_utc,
    )
    update: dict[str, Any] = {
        "holding_advice": advice,
        "ai": ai_summary,
        "holding_advice_at_utc": ts_utc,
    }
    revised_hold = advice.get("revised_hold_days")
    revised_stop = advice.get("revised_stop")
    if revised_hold is not None:
        try:
            update["ai_revised_hold_days"] = int(revised_hold)
        except (TypeError, ValueError):
            pass
    if revised_stop is not None:
        try:
            update["ai_revised_stop"] = float(revised_stop)
        except (TypeError, ValueError):
            pass
    pref.update(update)

    # Mirror onto signal row for Signals UI; close paper position on EXIT advice.
    sid = str(signal_doc_id or pdata.get("signal_doc_id") or "").strip()
    if sid:
        mirror_holding_advice_to_signal(
            db=db,
            signal_doc_id=sid,
            ticker=sym,
            advice=advice,
            paper_position_id=position_id,
            ai_summary=ai_summary,
        )
    if str(advice.get("advice") or "").upper() == "EXIT" and str(
        pdata.get("origin") or ""
    ) == "signal_paper":
        pref.update(
            {
                "status": "closed",
                "closed_at_utc": ts_utc,
                "exit_notes": f"Closed by holding advisor EXIT: {advice.get('headline') or ''}",
                "exit_origin": "holding_advisor",
            }
        )

    eval_doc: dict[str, Any] = {
        "eval_id": eval_id,
        "ts_utc": ts_utc,
        "stage": stage,
        "ticker": sym,
        "signal_doc_id": signal_doc_id or "",
        "signal_index": -1,
        "position_id": position_id,
        "model": model,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "estimated_cost_usd": estimated_cost_usd,
        "cost_estimated": cost_estimated,
        "decision": decision,
        "recommendation": advice,
        "detail": detail or {},
        "llm_source": getattr(usage, "source", ""),
    }
    db.collection(AI_EVALS_COLLECTION).document(eval_id).set(eval_doc)
    return eval_id


# Back-compat wrappers -------------------------------------------------

def write_evaluation(
    *,
    ticker: str,
    signal_doc_id: str,
    position_id: str | None,
    owner_uid: str | None,
    payload: dict[str, Any],
) -> None:
    """Legacy single-payload writer — prefer write_entry_evaluation."""
    from types import SimpleNamespace

    llm = payload.get("llm") if isinstance(payload.get("llm"), dict) else {}
    verdict = llm.get("verdict") if isinstance(llm.get("verdict"), dict) else {}
    scores = payload.get("scores") if isinstance(payload.get("scores"), dict) else {}
    recommendation = {
        "decision": str(verdict.get("action") or "WAIT").upper(),
        "headline": str(verdict.get("headline") or verdict.get("summary") or "")[:160],
        "why": str(verdict.get("why") or verdict.get("why_now") or ""),
        "scores": {
            "technical": 0.0,
            "ai": float(scores.get("conviction") or 0.0) * 16.0,
            "total": float(scores.get("total") or 0.0),
        },
        "plan": {
            "entry": {"ideal": 0.0, "min": 0.0, "max": 0.0},
            "stop": float(verdict.get("stop_loss") or 0.0),
            "target": 0.0,
            "hold_days": 3,
            "invalidation": str(verdict.get("invalidation") or ""),
        },
        "checklist": [],
        "detail": verdict,
    }
    usage = SimpleNamespace(
        model="unknown",
        prompt_tokens=0,
        completion_tokens=0,
        total_tokens=0,
        estimated_cost_usd=None,
        cost_estimated=False,
        source=str(llm.get("source") or "legacy"),
    )
    write_entry_evaluation(
        ticker=ticker,
        signal_doc_id=signal_doc_id,
        position_id=position_id,
        owner_uid=owner_uid,
        recommendation=recommendation,
        ai_gate="filtered",
        stage="entry",
        usage=usage,
        detail={"legacy_payload": True},
        apply_plan_overrides=False,
    )


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
    """Legacy record shape (debug / dry-run)."""
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
