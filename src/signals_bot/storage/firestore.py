from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Iterable

from dotenv import load_dotenv
from google.cloud import firestore
from google.oauth2 import service_account

from signals_bot.strategy.breakout import Signal


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


def _build_client() -> firestore.Client:
    load_dotenv(override=False)

    json_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    json_inline = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")

    if json_path:
        creds = service_account.Credentials.from_service_account_file(json_path)
        return firestore.Client(credentials=creds, project=creds.project_id)

    if json_inline:
        data = json.loads(json_inline)
        creds = service_account.Credentials.from_service_account_info(data)
        return firestore.Client(credentials=creds, project=creds.project_id)

    raise RuntimeError(
        "Missing Firestore credentials. Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON."
    )


def _pct_from_close(level: float | None, base: float | None) -> float | None:
    if level is None or base is None or base == 0:
        return None
    return ((level - base) / base) * 100.0


def write_universe_snapshot(
    *,
    asof_date: str,
    symbols: Iterable[str],
    collection: str = "universe",
    source: str = "finnhub_discovery",
) -> None:
    normalized = _normalize_universe_symbols(symbols)
    ts = datetime.now(timezone.utc).isoformat()
    doc = {
        "asof_date": asof_date,
        "symbols": normalized,
        "ts_utc": ts,
        "source": source,
    }
    db = _build_client()
    db.collection(collection).document(asof_date).set(doc)


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
    collection: str = "signals",
) -> None:
    buys = [s for s in signals if s.action == "BUY"]
    if not buys:
        return

    payload_signals: list[dict[str, Any]] = []
    for s in buys:
        close = s.close
        stop = s.suggested_stop
        target = s.suggested_target
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
            }
        )

    doc = {
        "run_id": run_id,
        "asof_date": asof_date,
        "ts_utc": datetime.now(timezone.utc).isoformat(),
        "signals": payload_signals,
    }

    db = _build_client()
    db.collection(collection).add(doc)
