"""Discover upcoming financial events for top universe symbols → Firestore ``stock_events/{asof_date}``."""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import finnhub
import yfinance as yf
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from signals_bot.config import load_config
from signals_bot.storage.firestore import (
    read_latest_universe_snapshot,
    read_top_universe_symbols_by_score,
    write_stock_events_snapshot,
)

YAHOO_FALLBACK_DELAY_SEC = 0.35


def _setup_logging(level: str) -> logging.Logger:
    log = logging.getLogger("discover_stock_events")
    if not log.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
        log.addHandler(h)
    log.setLevel(getattr(logging, level.upper(), logging.INFO))
    return log


def _score_from_detail(detail: dict[str, Any]) -> float:
    v = detail.get("last_score")
    if v is None:
        v = detail.get("score")
    try:
        return float(v)
    except (TypeError, ValueError):
        return -1.0


def _confidence_from_detail(detail: dict[str, Any]) -> int | None:
    v = detail.get("last_confidence")
    if v is None:
        v = detail.get("confidence")
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _parse_iso_date(raw: Any) -> date | None:
    if raw is None:
        return None
    s = str(raw).strip()[:10]
    if len(s) < 10:
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def _in_horizon(d: date, start: date, end: date) -> bool:
    return start <= d <= end


def _earnings_title(quarter: Any, year: Any) -> str:
    parts: list[str] = []
    if quarter is not None:
        try:
            parts.append(f"Q{int(quarter)}")
        except (TypeError, ValueError):
            pass
    if year is not None:
        try:
            parts.append(str(int(year)))
        except (TypeError, ValueError):
            pass
    return " ".join(parts) + " earnings" if parts else "Earnings"


def _fetch_finnhub_earnings(
    *,
    client: finnhub.Client,
    symbol_set: set[str],
    start: date,
    end: date,
    meta: dict[str, dict[str, Any]],
    log: logging.Logger,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    try:
        raw = client.earnings_calendar(
            _from=start.isoformat(),
            to=end.isoformat(),
            symbol="",
            international=False,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("Finnhub earnings_calendar failed: %s", e)
        return events

    rows: list[dict[str, Any]] = []
    if isinstance(raw, dict):
        cal = raw.get("earningsCalendar")
        if isinstance(cal, list):
            rows = [r for r in cal if isinstance(r, dict)]
    elif isinstance(raw, list):
        rows = [r for r in raw if isinstance(r, dict)]

    for row in rows:
        sym = str(row.get("symbol", "")).strip().upper()
        if sym not in symbol_set:
            continue
        event_d = _parse_iso_date(row.get("date"))
        if event_d is None or not _in_horizon(event_d, start, end):
            continue
        detail = meta.get(sym, {})
        eps = row.get("epsEstimate")
        rev = row.get("revenueEstimate")
        try:
            eps_f = float(eps) if eps is not None else None
        except (TypeError, ValueError):
            eps_f = None
        try:
            rev_f = float(rev) if rev is not None else None
        except (TypeError, ValueError):
            rev_f = None
        hour = str(row.get("hour") or "").strip().lower() or None
        events.append(
            {
                "symbol": sym,
                "event_type": "earnings",
                "event_date": event_d.isoformat(),
                "event_time": hour,
                "title": _earnings_title(row.get("quarter"), row.get("year")),
                "eps_estimate": eps_f,
                "revenue_estimate": rev_f,
                "last_score": _score_from_detail(detail),
                "last_confidence": _confidence_from_detail(detail),
                "data_source": "finnhub",
            }
        )
    log.info("Finnhub earnings: %d rows in window for top symbols", len(events))
    return events


def _yahoo_calendar_dict(sym: str) -> dict[str, Any]:
    t = yf.Ticker(sym)
    cal = getattr(t, "calendar", None)
    if cal is None:
        return {}
    if hasattr(cal, "to_dict"):
        try:
            d = cal.to_dict()
            if isinstance(d, dict):
                return d
        except Exception:  # noqa: BLE001
            pass
    if isinstance(cal, dict):
        return cal
    return {}


def _yahoo_dates_for_key(cal: dict[str, Any], key: str) -> list[date]:
    raw = cal.get(key)
    if raw is None:
        return []
    out: list[date] = []
    if isinstance(raw, list):
        items = raw
    else:
        items = [raw]
    for item in items:
        if hasattr(item, "date"):
            try:
                out.append(item.date())
                continue
            except Exception:  # noqa: BLE001
                pass
        d = _parse_iso_date(item)
        if d is not None:
            out.append(d)
    return out


def _fetch_yahoo_events(
    *,
    symbols: list[str],
    start: date,
    end: date,
    meta: dict[str, dict[str, Any]],
    symbols_with_earnings: set[str],
    log: logging.Logger,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for sym in symbols:
        if sym in symbols_with_earnings:
            continue
        time.sleep(YAHOO_FALLBACK_DELAY_SEC)
        try:
            cal = _yahoo_calendar_dict(sym)
        except Exception as e:  # noqa: BLE001
            log.warning("WAIT Yahoo calendar %s: %s", sym, e)
            continue
        if not cal:
            continue
        detail = meta.get(sym, {})
        for key, event_type in (
            ("Earnings Date", "earnings"),
            ("Ex-Dividend Date", "ex_dividend"),
            ("Dividend Date", "dividend"),
        ):
            for event_d in _yahoo_dates_for_key(cal, key):
                if not _in_horizon(event_d, start, end):
                    continue
                title = key.replace(" Date", "")
                events.append(
                    {
                        "symbol": sym,
                        "event_type": event_type,
                        "event_date": event_d.isoformat(),
                        "event_time": None,
                        "title": title,
                        "eps_estimate": None,
                        "revenue_estimate": None,
                        "last_score": _score_from_detail(detail),
                        "last_confidence": _confidence_from_detail(detail),
                        "data_source": "yahoo",
                    }
                )
    log.info("Yahoo fallback: %d event rows", len(events))
    return events


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Discover upcoming stock events for top universe symbols.")
    p.add_argument("--config", default="config.yaml", help="Path to config.yaml")
    p.add_argument("--top-symbols", type=int, default=None, help="Override events.top_symbols")
    p.add_argument("--horizon-days", type=int, default=None, help="Override events.horizon_days")
    p.add_argument(
        "--universe-doc-id",
        default="",
        help="Universe snapshot doc id (default: latest by ts_utc)",
    )
    p.add_argument("--dry-run", action="store_true", help="Log only; do not write Firestore")
    args = p.parse_args(argv)

    load_dotenv(override=False)
    cfg_path = Path(args.config).expanduser()
    if not cfg_path.is_absolute():
        cfg_path = (ROOT_DIR / cfg_path).resolve()
    cfg = load_config(cfg_path)
    log = _setup_logging(cfg.logging.level)

    top_n = int(args.top_symbols if args.top_symbols is not None else cfg.events.top_symbols)
    horizon = int(args.horizon_days if args.horizon_days is not None else cfg.events.horizon_days)
    universe_coll = cfg.universe.firestore.collection
    events_coll = cfg.events.collection

    universe_doc_id = (args.universe_doc_id or "").strip()
    if not universe_doc_id:
        latest = read_latest_universe_snapshot(collection=universe_coll)
        if not latest:
            log.error("No universe snapshot in Firestore collection=%s", universe_coll)
            return 1
        universe_doc_id = latest[0]
        log.info("Using latest universe doc id=%s", universe_doc_id)

    ranked = read_top_universe_symbols_by_score(
        doc_id=universe_doc_id,
        collection=universe_coll,
        limit=top_n,
    )
    if not ranked:
        log.error("No symbols with scores in universe/%s", universe_doc_id)
        return 1

    meta = {sym: detail for sym, detail in ranked}
    symbol_set = set(meta.keys())
    log.info("Top %d symbols by last_score from universe/%s", len(symbol_set), universe_doc_id)

    today = cfg.asof_date()
    end = today + timedelta(days=max(1, horizon))

    api_key = (os.getenv("FINNHUB_API_KEY") or "").strip()
    events: list[dict[str, Any]] = []
    symbols_with_fh_earnings: set[str] = set()

    if api_key:
        client = finnhub.Client(api_key=api_key)
        fh_events = _fetch_finnhub_earnings(
            client=client,
            symbol_set=symbol_set,
            start=today,
            end=end,
            meta=meta,
            log=log,
        )
        for ev in fh_events:
            if ev.get("event_type") == "earnings":
                symbols_with_fh_earnings.add(str(ev["symbol"]))
        events.extend(fh_events)
    else:
        log.warning("FINNHUB_API_KEY not set; skipping Finnhub earnings_calendar")

    yahoo_events = _fetch_yahoo_events(
        symbols=sorted(symbol_set),
        start=today,
        end=end,
        meta=meta,
        symbols_with_earnings=symbols_with_fh_earnings,
        log=log,
    )
    events.extend(yahoo_events)

    events.sort(key=lambda e: (e.get("event_date", ""), e.get("symbol", ""), e.get("event_type", "")))

    asof_date = today.isoformat()
    doc = {
        "asof_date": asof_date,
        "ts_utc": datetime.now(timezone.utc).isoformat(),
        "source": "discover_stock_events",
        "universe_doc_id": universe_doc_id,
        "top_symbols_n": len(symbol_set),
        "rank_by": cfg.events.rank_by,
        "horizon_days": horizon,
        "events": events,
    }

    symbols_with_events = len({e["symbol"] for e in events})
    log.info(
        "EVENTS summary: %d events for %d symbols (horizon %s → %s)",
        len(events),
        symbols_with_events,
        today.isoformat(),
        end.isoformat(),
    )

    if args.dry_run:
        log.info("Dry run — not writing Firestore")
        return 0

    write_stock_events_snapshot(asof_date=asof_date, doc=doc, collection=events_coll)
    log.info("Wrote %s/%s (%d events)", events_coll, asof_date, len(events))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
