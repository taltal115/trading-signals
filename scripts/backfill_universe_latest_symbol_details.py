"""One-time backfill: enrich latest Firestore ``universe`` doc ``symbol_details`` from Finnhub.

Fills missing ``country``, ``sector`` (finnhubIndustry), ``market_cap`` (marketCapitalization),
and refreshes ``name`` when empty — matching ``scripts/update_universe_finnhub.py`` profile merge.

Requires ``FINNHUB_API_KEY`` and ``GOOGLE_APPLICATION_CREDENTIALS`` (same as other scripts).

Usage::

  PYTHONPATH=./src python scripts/backfill_universe_latest_symbol_details.py --dry-run
  PYTHONPATH=./src python scripts/backfill_universe_latest_symbol_details.py
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from typing import Any

import finnhub
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from google.cloud import firestore

from signals_bot.storage.firestore import get_firestore_client


def _normalize_details_keys(details: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for k, v in (details or {}).items():
        sym = str(k).strip().upper()
        if sym and isinstance(v, dict):
            out[sym] = dict(v)
    return out


def _needs_profile_backfill(entry: dict[str, Any] | None) -> bool:
    if not entry:
        return True
    country = entry.get("country")
    sector = entry.get("sector")
    if country is None or (isinstance(country, str) and not country.strip()):
        return True
    if sector is None or (isinstance(sector, str) and not sector.strip()):
        return True
    if entry.get("market_cap") is None:
        return True
    return False


def _merge_profile(entry: dict[str, Any], profile: dict[str, Any] | None) -> dict[str, Any]:
    out = dict(entry)
    if not profile:
        return out
    name = profile.get("name")
    if isinstance(name, str) and name.strip():
        out["name"] = name.strip()
    ind = profile.get("finnhubIndustry")
    if isinstance(ind, str) and ind.strip():
        out["sector"] = ind.strip()
    country = profile.get("country")
    if isinstance(country, str) and country.strip():
        out["country"] = country.strip()
    mc = profile.get("marketCapitalization")
    if mc is not None:
        try:
            out["market_cap"] = float(mc)
        except (TypeError, ValueError):
            pass
    return out


def main() -> int:
    p = argparse.ArgumentParser(
        description="Backfill Finnhub profile fields on the most recent universe snapshot."
    )
    p.add_argument(
        "--collection",
        default="universe",
        help="Firestore collection (default: universe).",
    )
    p.add_argument(
        "--doc-id",
        default="",
        help="Document id (asof_date). Default: latest by ts_utc.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Log actions only; do not write Firestore.",
    )
    p.add_argument(
        "--sleep-every",
        type=int,
        default=30,
        help="Sleep 1s after this many Finnhub calls (rate limit; 0 = never).",
    )
    args = p.parse_args()

    load_dotenv(ROOT_DIR / ".env", override=False)
    api_key = (os.getenv("FINNHUB_API_KEY") or "").strip()
    if not api_key:
        print("ERROR: FINNHUB_API_KEY not set", file=sys.stderr)
        return 2

    db = get_firestore_client()
    coll = args.collection.strip() or "universe"

    if args.doc_id.strip():
        doc_ref = db.collection(coll).document(args.doc_id.strip())
        snap = doc_ref.get()
        if not snap.exists:
            print(f"ERROR: no document {coll}/{args.doc_id.strip()}", file=sys.stderr)
            return 2
    else:
        stream = (
            db.collection(coll)
            .order_by("ts_utc", direction=firestore.Query.DESCENDING)
            .limit(1)
            .stream()
        )
        snap = None
        doc_ref = None
        for s in stream:
            snap = s
            doc_ref = s.reference
            break
        if snap is None or doc_ref is None:
            print(f"ERROR: no documents in {coll!r}", file=sys.stderr)
            return 2

    data = snap.to_dict() or {}
    raw_symbols = data.get("symbols") or []
    if not isinstance(raw_symbols, list):
        print("ERROR: document has no symbols[] list", file=sys.stderr)
        return 2

    symbols = sorted({str(s).strip().upper() for s in raw_symbols if str(s).strip()})
    details = _normalize_details_keys(data.get("symbol_details"))

    to_fetch: list[str] = []
    for sym in symbols:
        if _needs_profile_backfill(details.get(sym)):
            to_fetch.append(sym)

    print(
        f"Doc id={doc_ref.id} symbols={len(symbols)} "
        f"need_profile_backfill={len(to_fetch)} dry_run={args.dry_run}"
    )

    client = finnhub.Client(api_key=api_key)
    filled = 0
    for i, sym in enumerate(to_fetch):
        entry = dict(details.get(sym) or {})
        before = _needs_profile_backfill(entry)
        try:
            profile = client.company_profile2(symbol=sym) or {}
        except Exception as exc:  # noqa: BLE001
            print(f"  WARN {sym}: profile error: {exc}")
            profile = {}
        merged = _merge_profile(entry, profile if isinstance(profile, dict) else {})
        details[sym] = merged
        if before and not _needs_profile_backfill(merged):
            filled += 1
            print(
                f"  OK {sym}: sector={merged.get('sector')!r} "
                f"country={merged.get('country')!r} mc={merged.get('market_cap')}"
            )
        elif before:
            print(f"  PARTIAL {sym}: still missing fields after profile")

        if args.sleep_every > 0 and (i + 1) % args.sleep_every == 0:
            time.sleep(1)

    # Ensure every symbol in list has a details row (minimal) for consistency
    for sym in symbols:
        if sym not in details:
            details[sym] = {"name": "", "confidence": 0, "score": 0.0}

    if args.dry_run:
        print(
            f"Dry run: would write symbol_details keys={len(details)} "
            f"rows_fully_filled_from_profile={filled}"
        )
        return 0

    doc_ref.update({"symbol_details": details})
    print(
        f"Wrote {coll}/{doc_ref.id} symbol_details entries={len(details)} "
        f"rows_fully_filled_from_profile={filled}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
