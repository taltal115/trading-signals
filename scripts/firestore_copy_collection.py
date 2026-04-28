#!/usr/bin/env python3
"""Copy all documents from one Firestore collection to another, preserving document IDs.

Use this when Firebase has no rename: you create the target path by writing the same IDs
into the new collection name.

Copies **top-level fields only** (same as ``.set()`` on the document); subcollections are
not copied — add a recursive tool later if you need them.

Examples (repo root, ``GOOGLE_APPLICATION_CREDENTIALS`` in ``.env``):

  PYTHONPATH=./src python scripts/firestore_copy_collection.py --from signals --to signals_old --dry-run
  PYTHONPATH=./src python scripts/firestore_copy_collection.py --from signals --to signals_old

  PYTHONPATH=./src python scripts/firestore_copy_collection.py --from OLD_CANONICAL --to signals --dry-run
  PYTHONPATH=./src python scripts/firestore_copy_collection.py --from OLD_CANONICAL --to signals
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
    p = argparse.ArgumentParser(description="Copy Firestore collection preserving document IDs.")
    p.add_argument(
        "--from",
        dest="from_coll",
        required=True,
        help="Source collection id (e.g. signals).",
    )
    p.add_argument(
        "--to",
        dest="to_coll",
        required=True,
        help="Destination collection id (e.g. signals_old).",
    )
    p.add_argument(
        "--merge",
        action="store_true",
        help="Merge into existing destination docs instead of overwriting.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print planned copies only (no writes).",
    )
    args = p.parse_args()

    if args.from_coll.strip() == args.to_coll.strip():
        print("ERROR: --from and --to must be different collection names.", file=sys.stderr)
        return 2

    load_dotenv(ROOT / ".env", override=False)
    db = get_firestore_client()
    src = db.collection(args.from_coll)
    n = 0
    ids_preview: list[str] = []

    for snap in src.stream():
        n += 1
        if len(ids_preview) < 15:
            ids_preview.append(snap.id)

    if args.dry_run:
        print(f"[dry-run] Would copy {n} document(s) from {args.from_coll!r} → {args.to_coll!r} (same IDs).")
        if ids_preview:
            print("  First IDs:", ", ".join(ids_preview) + (" …" if n > len(ids_preview) else ""))
        return 0

    # Actually stream again for write (streaming twice is simpler than buffering all payloads)
    n2 = 0
    batch = db.batch()
    batch_count = 0
    writes_per_batch = 400  # stay under Firestore 500 mutations/batch ceiling

    for snap in src.stream():
        data = snap.to_dict() or {}
        ref_to = db.collection(args.to_coll).document(snap.id)
        batch.set(ref_to, data, merge=args.merge)
        batch_count += 1
        n2 += 1

        if batch_count >= writes_per_batch:
            batch.commit()
            batch = db.batch()
            batch_count = 0
            print(f"  … committed {n2} writes")

    if batch_count:
        batch.commit()

    print(f"Done. Copied {n2} document(s) to {args.to_coll!r}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
