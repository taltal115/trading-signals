from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from dotenv import load_dotenv
from google.cloud import firestore
from google.oauth2 import service_account

from signals_bot.strategy.breakout import Signal

# Canonical bot/dashboard collection (deterministic run document ids).
SIGNALS_COLLECTION = "signals"
# Archived legacy auto-id runs (Firestore ``signals`` renamed to ``signals_old``).
SIGNALS_COLLECTION_LEGACY_ARCHIVE = "signals_old"
# Canonical open positions collection (Firestore; deterministic doc ids).
MY_POSITIONS_COLLECTION = "my_positions"
# Archived legacy auto-id rows (Firestore ``my_positions`` renamed to ``my_positions_old``).
MY_POSITIONS_COLLECTION_LEGACY_ARCHIVE = "my_positions_old"
# Staging collection for deterministic ids before renaming collections in Firebase.
MY_POSITIONS_STAGING_COLLECTION = "my_positions_new"
# Synthetic owner for bot BUY signals treated as open paper positions (holding advisor / monitor).
SIGNAL_PAPER_OWNER_UID = "__signal_paper__"


def _normalize_universe_symbols(symbols: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in symbols:
        sym = str(raw).strip().upper()
        if not sym or sym in seen:
            continue
        seen.add(sym)
        out.append(sym)
    return sorted(out)


def _load_service_account_dict(gac: str) -> dict[str, Any]:
    """Parse inline JSON or a JSON file path into a service-account dict."""
    if gac.startswith("{"):
        return json.loads(gac)
    path = Path(gac).expanduser()
    if not path.is_file():
        raise RuntimeError(
            "GOOGLE_APPLICATION_CREDENTIALS is not an existing file path and does not start with '{' "
            "(inline JSON). Fix the path or paste the full service account JSON."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def _normalize_service_account_private_key(data: dict[str, Any]) -> dict[str, Any]:
    """Fix PEM newlines often mangled when JSON is pasted into GitHub/env (literal \\n vs newline).

    Without this, ``invalid_grant: Invalid JWT Signature`` is common in CI even when JSON parses.
    """
    key = data.get("private_key")
    if not isinstance(key, str):
        return data
    return {**data, "private_key": key.replace("\\n", "\n")}


def get_firestore_client() -> firestore.Client:
    """Build a Firestore client using ``GOOGLE_APPLICATION_CREDENTIALS``.

    - **Local:** set to the filesystem path of your service account JSON key.
    - **GitHub Actions:** set the repository secret to the **full JSON text** of that key
      (the value must start with ``{``; it is parsed inline, not as a path).
    """
    load_dotenv(override=False)

    gac_raw = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    gac = (gac_raw or "").strip().removeprefix("\ufeff")
    if not gac:
        raise RuntimeError(
            "Missing Firestore credentials. Set GOOGLE_APPLICATION_CREDENTIALS "
            "(path to a service account JSON file locally, or the full JSON string in CI)."
        )

    data = _normalize_service_account_private_key(_load_service_account_dict(gac))
    creds = service_account.Credentials.from_service_account_info(data)
    return firestore.Client(credentials=creds, project=creds.project_id)


def _build_client() -> firestore.Client:
    return get_firestore_client()


def _pct_from_close(level: float | None, base: float | None) -> float | None:
    if level is None or base is None or base == 0:
        return None
    return ((level - base) / base) * 100.0


def utc_datetime_lex_id(dt: datetime) -> str:
    """Deterministic lex-sortable Firestore doc id suffix (aligned with signals run ids).

    Format ``YYYY-MM-DDTHH-MM-SS.ffffffZ`` — full UTC datetime from ``dt``.
    Used for migrations (e.g. position rows keyed by ``created_at_utc``).
    """
    if dt.tzinfo is None:
        dt_u = dt.replace(tzinfo=timezone.utc)
    else:
        dt_u = dt.astimezone(timezone.utc)
    date_part = dt_u.strftime("%Y-%m-%d")
    clock = dt_u.strftime("%H-%M-%S")
    return f"{date_part}T{clock}.{dt_u.microsecond:06d}Z"


def _parse_ts_utc_iso(ts_utc: str) -> datetime:
    """Parse Firestore ts_utc (ISO-8601) to UTC aware datetime."""
    raw = (ts_utc or "").strip()
    if not raw:
        return datetime.now(timezone.utc)
    try:
        tnorm = raw.replace("Z", "+00:00") if raw.endswith("Z") else raw
        dt = datetime.fromisoformat(tnorm)
        if dt.tzinfo is not None:
            return dt.astimezone(timezone.utc)
        return dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.now(timezone.utc)


def signals_run_document_id(*, asof_date: str, ts_utc: str, run_id: str) -> str:
    """Sortable, human-readable UTC id (lexicographic order == chronological).

    Format: ``YYYY-MM-DDTHH-MM-SS.ffffffZ`` — ISO-8601-style: date, ``T``, zero-padded
    clock with dashes (not colons, for fewer tooling issues), dot + 6-digit microseconds,
    trailing ``Z``. Date prefers ``asof_date`` when ``YYYY-MM-DD``; time from ``ts_utc``.

    ``run_id`` is kept for API compatibility. Migration adds ``_dupN`` on collision.
    """
    del run_id
    dt = _parse_ts_utc_iso(ts_utc)
    asof = (asof_date or "").strip()
    if asof and re.fullmatch(r"\d{4}-\d{2}-\d{2}", asof):
        date_part = asof
    else:
        date_part = dt.strftime("%Y-%m-%d")
    clock = dt.strftime("%H-%M-%S")
    return f"{date_part}T{clock}.{dt.microsecond:06d}Z"


def _universe_symbol_list_from_doc(
    ref: firestore.DocumentReference,
    data: dict[str, Any],
) -> list[str]:
    """Return the full ticker list for a universe snapshot (legacy arrays or subcollection ids)."""
    raw = data.get("symbols")
    if isinstance(raw, list) and raw:
        return _normalize_universe_symbols(str(s) for s in raw)

    if data.get("symbol_details_in_subcollection"):
        out: list[str] = []
        for snap in ref.collection("symbols").stream():
            sym = snap.id.strip().upper()
            if sym:
                out.append(sym)
        return sorted(out)

    inline = data.get("symbol_details")
    if isinstance(inline, dict) and inline:
        return sorted(str(k).strip().upper() for k in inline if str(k).strip())
    return []


def write_universe_snapshot(
    *,
    asof_date: str,
    symbols: Iterable[str],
    collection: str = "universe",
    source: str = "finnhub_discovery",
    symbol_details: dict[str, dict] | None = None,
    active_symbols: Iterable[str] | None = None,
    inactive_symbols: Iterable[str] | None = None,
    status_counts: dict[str, int] | None = None,
) -> None:
    """Write the daily universe doc.

    Parent holds metadata + a compact ``symbols`` ticker list (for API pagination) and
    ``active_symbols`` (bot scan list). Per-symbol fields live in the ``symbols`` **subcollection**
    so the parent stays under Firestore's index-entry limit (~40k). Do not store inline
    ``symbol_details`` or duplicate ``inactive_symbols`` on the parent.

    Legacy snapshots may still have inline ``symbol_details``; readers fall back when needed.
    """
    del inactive_symbols  # counts only — full inactive list is not stored on the parent doc
    normalized = _normalize_universe_symbols(symbols)
    ts = datetime.now(timezone.utc).isoformat()
    doc: dict[str, Any] = {
        "asof_date": asof_date,
        "symbols": normalized,
        "ts_utc": ts,
        "source": source,
        "symbol_count": len(normalized),
        "symbol_details_in_subcollection": True,
    }
    if active_symbols is not None:
        active_norm = _normalize_universe_symbols(active_symbols)
        doc["active_symbols"] = active_norm
        doc["active_count"] = len(active_norm)
        doc["inactive_count"] = max(0, len(normalized) - len(active_norm))
    if status_counts:
        doc["status_counts"] = {str(k): int(v) for k, v in status_counts.items()}
    db = _build_client()
    parent_ref = db.collection(collection).document(asof_date)
    if symbol_details:
        _write_universe_symbol_details_subcollection(parent_ref, symbol_details)
    # Full replace drops legacy inline ``symbol_details`` / ``inactive_symbols``.
    parent_ref.set(doc)


def write_universe_symbol_details_subcollection(
    parent_ref: firestore.DocumentReference,
    symbol_details: dict[str, dict],
) -> None:
    """Write per-symbol detail docs (batched). Avoids INDEX_ENTRIES_COUNT_LIMIT on parent."""
    _write_universe_symbol_details_subcollection(parent_ref, symbol_details)


def _write_universe_symbol_details_subcollection(
    parent_ref: firestore.DocumentReference,
    symbol_details: dict[str, dict],
) -> None:
    """Write per-symbol detail docs (batched). Avoids INDEX_ENTRIES_COUNT_LIMIT on parent."""
    sub = parent_ref.collection("symbols")
    db = _build_client()
    batch = db.batch()
    pending = 0
    for raw_sym, detail in symbol_details.items():
        sym = str(raw_sym).strip().upper()
        if not sym or not isinstance(detail, dict):
            continue
        batch.set(sub.document(sym), detail)
        pending += 1
        if pending >= 400:
            batch.commit()
            batch = db.batch()
            pending = 0
    if pending > 0:
        batch.commit()


def read_latest_universe_snapshot(
    *,
    collection: str = "universe",
) -> tuple[str, dict[str, Any]] | None:
    """Return ``(document_id, data)`` for the most recent universe snapshot, or ``None``."""
    db = _build_client()
    docs = (
        db.collection(collection)
        .order_by("ts_utc", direction=firestore.Query.DESCENDING)
        .limit(1)
        .stream()
    )
    for snap in docs:
        return snap.id, snap.to_dict() or {}
    return None


def read_universe_symbol_details(
    *,
    doc_id: str,
    collection: str = "universe",
    symbols: Iterable[str] | None = None,
) -> dict[str, dict[str, Any]]:
    """Load ``symbol_details`` from inline map (legacy) or ``symbols`` subcollection."""
    db = _build_client()
    ref = db.collection(collection).document(doc_id.strip())
    snap = ref.get()
    if not snap.exists:
        return {}
    data = snap.to_dict() or {}
    wanted: set[str] | None = None
    if symbols is not None:
        wanted = {str(s).strip().upper() for s in symbols if str(s).strip()}

    inline = data.get("symbol_details")
    if isinstance(inline, dict) and inline:
        out: dict[str, dict[str, Any]] = {}
        for k, v in inline.items():
            if not isinstance(v, dict):
                continue
            sym = str(k).strip().upper()
            if not sym or (wanted is not None and sym not in wanted):
                continue
            out[sym] = v
        return out

    sub = ref.collection("symbols")
    out = {}
    if wanted is None:
        for s in sub.stream():
            sym = s.id.strip().upper()
            if sym:
                out[sym] = s.to_dict() or {}
        return out

    refs = [sub.document(sym) for sym in sorted(wanted)]
    for s in db.get_all(refs):
        if s.exists:
            sym = s.id.strip().upper()
            if sym:
                out[sym] = s.to_dict() or {}
    return out


def read_latest_universe_snapshot_doc(
    *,
    collection: str = "universe",
) -> dict[str, Any] | None:
    """Return the most recent universe document (raw dict) or ``None`` when the collection is empty.

    Used by discovery to inherit per-symbol streaks / ``last_active_at`` between runs without scanning
    the whole history. Caller decides what to do when the previous doc lacks new fields.
    """
    got = read_latest_universe_snapshot(collection=collection)
    return got[1] if got else None


def read_recent_universe_symbols(
    *,
    collection: str = "universe",
    limit: int = 7,
) -> list[str]:
    """Read symbols from the most recent *limit* universe snapshots and merge them."""
    db = _build_client()
    docs = (
        db.collection(collection)
        .order_by("ts_utc", direction=firestore.Query.DESCENDING)
        .limit(limit)
        .stream()
    )
    merged: set[str] = set()
    for snap in docs:
        data = snap.to_dict() or {}
        ref = db.collection(collection).document(snap.id)
        for sym in _universe_symbol_list_from_doc(ref, data):
            merged.add(sym)
    return sorted(merged)


def _bot_symbols_from_doc(data: dict[str, Any]) -> list[str]:
    """Return the bot's working slice from a universe doc.

    Prefers ``active_symbols`` when that field is present (even if empty — do not expand to
    the full history list). Legacy snapshots without ``active_symbols`` fall back to ``symbols``.
    """
    if "active_symbols" in data:
        raw = data.get("active_symbols")
        if not isinstance(raw, list):
            return []
        return _normalize_universe_symbols(str(s) for s in raw)
    raw = data.get("symbols") or []
    if not isinstance(raw, list):
        return []
    return _normalize_universe_symbols(str(s) for s in raw)


def read_universe_for_date(
    *,
    asof_date: str,
    collection: str = "universe",
    fallback_latest: bool = True,
) -> list[str]:
    """Load the bot scan list for ``asof_date``.

    When today's snapshot exists but ``active_symbols`` is empty, do **not** silently scan the
    full inactive history pool. Optionally fall back to the latest snapshot that has actives.
    """
    import logging

    log = logging.getLogger(__name__)
    db = _build_client()
    ref = db.collection(collection).document(asof_date)
    snap = ref.get()
    if snap.exists:
        data = snap.to_dict() or {}
        if "active_symbols" in data:
            got = _bot_symbols_from_doc(data)
            if got:
                return got
            log.warning(
                "Universe %s/%s has active_count=0 (empty active_symbols). "
                "Not expanding to the full symbol history list.",
                collection,
                asof_date,
            )
        else:
            got = _bot_symbols_from_doc(data)
            if got:
                return got

    if not fallback_latest:
        raise ValueError(
            f"Firestore universe document missing or empty for asof_date={asof_date!r} "
            f"(collection={collection!r})."
        )

    latest = (
        db.collection(collection)
        .order_by("ts_utc", direction=firestore.Query.DESCENDING)
        .limit(5)
        .stream()
    )
    for doc_snap in latest:
        data = doc_snap.to_dict() or {}
        got = _bot_symbols_from_doc(data)
        if got:
            if doc_snap.id != asof_date:
                log.warning(
                    "Universe asof_date=%s has no active symbols; using prior snapshot %s "
                    "(%d active).",
                    asof_date,
                    doc_snap.id,
                    len(got),
                )
            return got

    raise ValueError(
        f"No universe snapshot with active symbols for asof_date={asof_date!r} "
        f"(collection={collection!r}). Run discovery or seed Firestore."
    )


IBKR_PORTFOLIO_COLLECTION = "ibkr_portfolio"
IBKR_PORTFOLIO_LATEST_DOC = "latest"


def write_buy_signals(
    *,
    signals: Iterable[Signal],
    run_id: str,
    asof_date: str,
) -> None:
    buys = [s for s in signals if s.action == "BUY"]
    if not buys:
        return

    payload_signals: list[dict[str, Any]] = []
    for s in buys:
        close = s.close
        stop = s.suggested_stop
        target = s.suggested_target
        m = s.metrics or {}
        payload_signals.append(
            {
                "ticker": s.ticker,
                "confidence": s.confidence,
                "score": s.score,
                "close": close,
                "hold_days": s.max_hold_days,
                "stop": stop,
                "stop_pct": _pct_from_close(stop, close),
                "target": target,
                "target_pct": _pct_from_close(target, close),
                "estimated_hold_days": m.get("estimated_hold_days"),
                "sector": m.get("sector"),
                "industry": m.get("industry"),
                "pipeline_stage": "technical",
                "ai_gate": "pending",
            }
        )

    doc = {
        "run_id": run_id,
        "asof_date": asof_date,
        "ts_utc": datetime.now(timezone.utc).isoformat(),
        "signals": payload_signals,
    }

    db = _build_client()
    new_id = signals_run_document_id(asof_date=asof_date, ts_utc=str(doc["ts_utc"]), run_id=run_id)
    db.collection(SIGNALS_COLLECTION).document(new_id).set(doc)

    # Treat every BUY as an open paper position so holding/monitor AI flows apply.
    paper_ids: list[str] = []
    for row in payload_signals:
        pid = upsert_signal_paper_position(
            db=db,
            signal_doc_id=new_id,
            signal_row=row,
            asof_date=asof_date,
        )
        paper_ids.append(pid)
    if paper_ids:
        # Stamp paper_position_id back onto each signal row for the UI.
        snap = db.collection(SIGNALS_COLLECTION).document(new_id).get()
        data = snap.to_dict() or {}
        sigs = list(data.get("signals") or [])
        by_ticker = {str(r.get("ticker", "")).upper(): pid for r, pid in zip(payload_signals, paper_ids)}
        new_sigs = []
        for r in sigs:
            if not isinstance(r, dict):
                new_sigs.append(r)
                continue
            nr = dict(r)
            t = str(nr.get("ticker", "")).upper()
            if t in by_ticker:
                nr["paper_position_id"] = by_ticker[t]
                nr["paper_status"] = "open"
            new_sigs.append(nr)
        db.collection(SIGNALS_COLLECTION).document(new_id).update({"signals": new_sigs})


def paper_position_doc_id(*, signal_doc_id: str, ticker: str) -> str:
    """Deterministic id so re-runs upsert instead of duplicating paper positions."""
    sid = re.sub(r"[^A-Za-z0-9._-]+", "_", signal_doc_id.strip())[:120]
    sym = ticker.strip().upper()
    return f"paper__{sid}__{sym}"


def upsert_signal_paper_position(
    *,
    db: firestore.Client | None = None,
    signal_doc_id: str,
    signal_row: dict[str, Any],
    asof_date: str = "",
) -> str:
    """Create/update a my_positions row owned by SIGNAL_PAPER_OWNER_UID for a BUY signal."""
    client = db or _build_client()
    ticker = str(signal_row.get("ticker") or "").strip().upper()
    if not ticker:
        raise ValueError("signal_row missing ticker")
    pos_id = paper_position_doc_id(signal_doc_id=signal_doc_id, ticker=ticker)
    ref = client.collection(MY_POSITIONS_COLLECTION).document(pos_id)
    existing = ref.get()
    now = datetime.now(timezone.utc).isoformat()
    entry = float(signal_row.get("close") or 0.0)
    stop = signal_row.get("stop")
    target = signal_row.get("target")
    hold_days = signal_row.get("hold_days")
    try:
        hold_i = int(hold_days) if hold_days is not None else None
    except (TypeError, ValueError):
        hold_i = None

    base: dict[str, Any] = {
        "ticker": ticker,
        "entry_price": entry,
        "quantity": None,
        "stop_price": float(stop) if stop is not None else None,
        "target_price": float(target) if target is not None else None,
        "signal_doc_id": signal_doc_id.strip(),
        "signal_confidence": signal_row.get("confidence"),
        "hold_days_from_signal": hold_i,
        "signal_close_price": entry,
        "sector": signal_row.get("sector"),
        "industry": signal_row.get("industry"),
        "estimated_hold_days": signal_row.get("estimated_hold_days"),
        "status": "open",
        "origin": "signal_paper",
        "owner_uid": SIGNAL_PAPER_OWNER_UID,
        "owner_email": "signal-paper@bot.local",
        "owner_display_name": "Signal paper",
        "notes": "Auto-opened from bot BUY signal (paper).",
        "updated_at_utc": now,
        "ai_gate": signal_row.get("ai_gate") or "pending",
        "asof_date": asof_date or "",
    }
    if signal_row.get("recommendation") is not None:
        base["recommendation"] = signal_row.get("recommendation")
    if signal_row.get("ai") is not None:
        base["ai"] = signal_row.get("ai")

    if existing.exists:
        prev = existing.to_dict() or {}
        # Do not reopen if already closed by monitor/advisor.
        if str(prev.get("status") or "").lower() == "closed":
            return pos_id
        patch = {k: v for k, v in base.items() if k not in ("created_at_utc", "owner_uid", "origin")}
        # Keep created_at_utc; refresh plan levels from latest signal/AI.
        ref.set(patch, merge=True)
    else:
        base["created_at_utc"] = now
        ref.set(base)
    return pos_id


def mirror_holding_advice_to_signal(
    *,
    db: firestore.Client | None = None,
    signal_doc_id: str,
    ticker: str,
    advice: dict[str, Any],
    paper_position_id: str,
    ai_summary: dict[str, Any] | None = None,
) -> None:
    """Copy holding advice onto the signals[] row for the Signals UI."""
    if not signal_doc_id.strip() or not ticker.strip():
        return
    client = db or _build_client()
    ref = client.collection(SIGNALS_COLLECTION).document(signal_doc_id.strip())
    sym = ticker.strip().upper()

    @firestore.transactional
    def _do(transaction, run_ref):  # type: ignore[no-untyped-def]
        snap = run_ref.get(transaction=transaction)
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
                r["holding_advice"] = advice
                r["holding_advice_at_utc"] = datetime.now(timezone.utc).isoformat()
                r["paper_position_id"] = paper_position_id
                r["paper_status"] = "open"
                if ai_summary:
                    r["holding_ai"] = ai_summary
                if str(advice.get("advice") or "").upper() == "EXIT":
                    r["paper_status"] = "exit_advised"
            new_sigs.append(r)
        transaction.update(run_ref, {"signals": new_sigs})

    txn = client.transaction()
    _do(txn, ref)


def _holdings_from_portfolio_doc(data: dict[str, Any]) -> tuple[set[str], dict[str, dict[str, Any]]]:
    holdings: set[str] = set()
    merged: dict[str, dict[str, Any]] = {}
    positions = data.get("positions")
    if not isinstance(positions, list):
        return holdings, merged
    for raw in positions:
        if not isinstance(raw, dict):
            continue
        ticker = str(raw.get("ticker") or "").strip().upper()
        if not ticker:
            continue
        qty = raw.get("qty")
        try:
            qty_f = float(qty) if qty is not None else 0.0
        except (TypeError, ValueError):
            qty_f = 0.0
        if abs(qty_f) < 1e-12:
            continue
        holdings.add(ticker)
        merged[ticker] = {
            "price": raw.get("avg_cost"),
            "time": None,
            "qty": qty_f,
            "mkt_value": raw.get("mkt_value"),
            "unrealized_pnl": raw.get("unrealized_pnl"),
            "conid": raw.get("conid"),
        }
    return holdings, merged


def write_ibkr_portfolio_snapshot(
    doc: dict[str, Any],
    *,
    collection: str = IBKR_PORTFOLIO_COLLECTION,
) -> str:
    """Write portfolio snapshot to ``{collection}/{account_id}`` and ``{collection}/latest``."""
    account_id = str(doc.get("account_id") or "").strip()
    if not account_id:
        raise ValueError("IBKR portfolio snapshot missing account_id")
    db = _build_client()
    coll = db.collection(collection)
    coll.document(account_id).set(doc)
    coll.document(IBKR_PORTFOLIO_LATEST_DOC).set(doc)
    return account_id


def read_ibkr_portfolio_doc(
    *,
    collection: str = IBKR_PORTFOLIO_COLLECTION,
    account_id: str | None = None,
) -> dict[str, Any] | None:
    db = _build_client()
    coll = db.collection(collection)
    if account_id:
        snap = coll.document(account_id.strip()).get()
        return snap.to_dict() if snap.exists else None
    snap = coll.document(IBKR_PORTFOLIO_LATEST_DOC).get()
    return snap.to_dict() if snap.exists else None


def read_ibkr_portfolio_holdings(
    *,
    collection: str = IBKR_PORTFOLIO_COLLECTION,
    account_id: str | None = None,
    max_age_min: int = 30,
) -> tuple[set[str], dict[str, dict[str, Any]]]:
    """Return holdings if snapshot exists and is younger than ``max_age_min`` (0 = any age)."""
    data = read_ibkr_portfolio_doc(collection=collection, account_id=account_id)
    if not data:
        return set(), {}
    ts_raw = str(data.get("ts_utc") or "").strip()
    if max_age_min > 0 and ts_raw:
        try:
            tnorm = ts_raw.replace("Z", "+00:00") if ts_raw.endswith("Z") else ts_raw
            ts = datetime.fromisoformat(tnorm)
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            else:
                ts = ts.astimezone(timezone.utc)
            age_min = (datetime.now(timezone.utc) - ts).total_seconds() / 60.0
            if age_min > max_age_min:
                return set(), {}
        except ValueError:
            return set(), {}
    return _holdings_from_portfolio_doc(data)

