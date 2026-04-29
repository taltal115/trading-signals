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


def write_universe_snapshot(
    *,
    asof_date: str,
    symbols: Iterable[str],
    collection: str = "universe",
    source: str = "finnhub_discovery",
    symbol_details: dict[str, dict] | None = None,
) -> None:
    normalized = _normalize_universe_symbols(symbols)
    ts = datetime.now(timezone.utc).isoformat()
    doc = {
        "asof_date": asof_date,
        "symbols": normalized,
        "ts_utc": ts,
        "source": source,
    }
    if symbol_details:
        doc["symbol_details"] = symbol_details
    db = _build_client()
    db.collection(collection).document(asof_date).set(doc)


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
        raw = data.get("symbols") or []
        if isinstance(raw, list):
            for s in raw:
                sym = str(s).strip().upper()
                if sym:
                    merged.add(sym)
    return sorted(merged)


def read_universe_for_date(
    *,
    asof_date: str,
    collection: str = "universe",
    fallback_latest: bool = True,
) -> list[str]:
    db = _build_client()
    ref = db.collection(collection).document(asof_date)
    snap = ref.get()
    if snap.exists:
        data = snap.to_dict() or {}
        raw = data.get("symbols") or []
        if isinstance(raw, list) and raw:
            got = _normalize_universe_symbols(str(s) for s in raw)
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
        .limit(1)
        .stream()
    )
    for doc_snap in latest:
        data = doc_snap.to_dict() or {}
        raw = data.get("symbols") or []
        if isinstance(raw, list) and raw:
            return _normalize_universe_symbols(str(s) for s in raw)
        break

    raise ValueError(
        f"No universe snapshot found for asof_date={asof_date!r} and no prior documents in "
        f"collection={collection!r}. Run discovery or seed Firestore."
    )


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
