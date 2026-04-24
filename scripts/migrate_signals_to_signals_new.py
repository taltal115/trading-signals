#!/usr/bin/env python3
"""Copy Firestore ``signals`` → ``signals_new`` with deterministic document IDs (date_time format).

Does not delete or modify ``signals``. Safe to re-run: overwrites same ``signals_new`` doc id
if source data unchanged (same id).

ID format: ``YYYY-MM-DDTHH-MM-SS.ffffffZ`` (UTC, lexicographic sort = time order) — see
``signals_new_document_id`` in firestore.py.

Usage (repo root, .env with GOOGLE_APPLICATION_CREDENTIALS):

  PYTHONPATH=./src python scripts/migrate_signals_to_signals_new.py --dry-run
  PYTHONPATH=./src python scripts/migrate_signals_to_signals_new.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from dotenv import load_dotenv

from signals_bot.storage.firestore import (  # noqa: E402
    SIGNALS_COLLECTION_LEGACY,
    SIGNALS_COLLECTION_NEW,
    get_firestore_client,
    signals_new_document_id,
)


def main() -> int:
    p = argparse.ArgumentParser(description="Copy signals → signals_new with deterministic IDs.")
    p.add_argument("--dry-run", action="store_true", help="Print planned writes only.")
    p.add_argument(
        "--source",
        default=SIGNALS_COLLECTION_LEGACY,
        help=f"Source collection (default: {SIGNALS_COLLECTION_LEGACY})",
    )
    p.add_argument(
        "--dest",
        default=SIGNALS_COLLECTION_NEW,
        help=f"Destination collection (default: {SIGNALS_COLLECTION_NEW})",
    )
    args = p.parse_args()

    load_dotenv(ROOT / ".env", override=False)
    db = get_firestore_client()
    src = db.collection(args.source)
    used: set[str] = set()
    n = 0
    for snap in src.stream():
        data = snap.to_dict() or {}
        rid = str(data.get("run_id") or snap.id)
        ts = str(data.get("ts_utc") or "")
        asof = str(data.get("asof_date") or "")
        base = signals_new_document_id(asof_date=asof, ts_utc=ts, run_id=rid)
        nid = base
        k = 0
        while nid in used:
            k += 1
            nid = f"{base}_dup{k}"
        used.add(nid)
        n += 1
        if args.dry_run:
            print(f"DRY-RUN {snap.id} -> {nid} run_id={rid!r} asof={asof!r}")
        else:
            db.collection(args.dest).document(nid).set(data)
            print(f"OK {snap.id} -> {nid}")
    print(f"Done. Migrated {n} documents to {args.dest!r}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
