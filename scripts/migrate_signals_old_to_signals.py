#!/usr/bin/env python3
"""Copy Firestore legacy archive ``signals_old`` → canonical ``signals`` with deterministic IDs.

Typically run once after archiving legacy ``signals`` under ``signals_old`` and
consolidating canonical deterministic runs under ``signals``. Use this script if rows
remain only under ``signals_old`` and need ids regenerated instead of preserved.

Does not delete ``signals_old``. Safe to re-run: overwrites same ``signals`` doc id.

ID format: ``YYYY-MM-DDTHH-MM-SS.ffffffZ`` — see ``signals_run_document_id`` in firestore.py.

Usage (repo root, .env with GOOGLE_APPLICATION_CREDENTIALS):

  PYTHONPATH=./src python scripts/migrate_signals_old_to_signals.py --dry-run
  PYTHONPATH=./src python scripts/migrate_signals_old_to_signals.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from dotenv import load_dotenv

from signals_bot.storage.firestore import (  # noqa: E402
    SIGNALS_COLLECTION,
    SIGNALS_COLLECTION_LEGACY_ARCHIVE,
    get_firestore_client,
    signals_run_document_id,
)


def main() -> int:
    p = argparse.ArgumentParser(description="Copy signals_old → signals with deterministic IDs.")
    p.add_argument("--dry-run", action="store_true", help="Print planned writes only.")
    p.add_argument(
        "--source",
        default=SIGNALS_COLLECTION_LEGACY_ARCHIVE,
        help=f"Source collection (default: {SIGNALS_COLLECTION_LEGACY_ARCHIVE})",
    )
    p.add_argument(
        "--dest",
        default=SIGNALS_COLLECTION,
        help=f"Destination collection (default: {SIGNALS_COLLECTION})",
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
        base = signals_run_document_id(asof_date=asof, ts_utc=ts, run_id=rid)
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
