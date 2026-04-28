#!/usr/bin/env python3
"""Delete every document in a Firestore collection (top-level only).

Subcollections under those documents are **not** removed automatically; delete them in the
console or extend this script if you use nested data.

For the common “rename” flow, use this only after you have copied the data elsewhere and
verified the copy.

Examples:

  PYTHONPATH=./src python scripts/firestore_delete_collection_docs.py --collection signals --dry-run
  PYTHONPATH=./src python scripts/firestore_delete_collection_docs.py --collection signals --execute --i-understand
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from dotenv import load_dotenv

from signals_bot.storage.firestore import get_firestore_client


def main() -> int:
    p = argparse.ArgumentParser(description="Delete all documents in a Firestore collection.")
    p.add_argument("--collection", required=True, help="Collection id to clear (e.g. signals).")
    p.add_argument("--dry-run", action="store_true", help="Count documents only; do not delete.")
    p.add_argument(
        "--execute",
        action="store_true",
        help="Perform deletes (must be used with --i-understand).",
    )
    p.add_argument(
        "--i-understand",
        action="store_true",
        help="Required together with --execute (safety flag).",
    )
    args = p.parse_args()

    if args.dry_run:
        args.execute = False

    if args.execute and not args.i_understand:
        print("ERROR: --execute requires --i-understand", file=sys.stderr)
        return 2

    load_dotenv(ROOT / ".env", override=False)
    db = get_firestore_client()
    col = db.collection(args.collection)

    ids: list[str] = []
    for snap in col.stream():
        ids.append(snap.id)

    print(f"Collection {args.collection!r}: {len(ids)} document(s).")
    if args.dry_run or not args.execute:
        if ids and len(ids) <= 20:
            print("  IDs:", ", ".join(ids))
        elif ids:
            print("  First IDs:", ", ".join(ids[:15]), "…")
        if not args.execute:
            print("No deletes performed (use --execute --i-understand to delete).")
        return 0

    batch = db.batch()
    n = 0
    batch_count = 0
    chunk = 400

    for did in ids:
        batch.delete(col.document(did))
        batch_count += 1
        n += 1
        if batch_count >= chunk:
            batch.commit()
            batch = db.batch()
            batch_count = 0
            print(f"  … deleted {n} / {len(ids)}")

    if batch_count:
        batch.commit()

    print(f"Done. Deleted {n} document(s) from {args.collection!r}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
