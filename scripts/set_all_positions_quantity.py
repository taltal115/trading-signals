"""Set `quantity` on all documents in Firestore ``my_positions``.

Requires `GOOGLE_APPLICATION_CREDENTIALS` (see `src/signals_bot/storage/firestore.py`).

Example:
  python scripts/set_all_positions_quantity.py
  python scripts/set_all_positions_quantity.py --quantity 10 --dry-run
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from google.cloud import firestore  # noqa: E402

from signals_bot.storage.firestore import MY_POSITIONS_COLLECTION, get_firestore_client  # noqa: E402


def _commit_batches(
    db: firestore.Client,
    updates: list[tuple[firestore.DocumentReference, dict]],
) -> int:
    """Return number of documents updated. Firestore batch max 500 operations."""
    n = 0
    batch = db.batch()
    pending = 0
    for ref, data in updates:
        batch.set(ref, data, merge=True)
        pending += 1
        n += 1
        if pending >= 500:
            batch.commit()
            batch = db.batch()
            pending = 0
    if pending:
        batch.commit()
    return n


def main() -> int:
    p = argparse.ArgumentParser(description=f"Set quantity on all {MY_POSITIONS_COLLECTION!r} documents.")
    p.add_argument(
        "--collection",
        default=MY_POSITIONS_COLLECTION,
        help=f"Collection name (default: {MY_POSITIONS_COLLECTION}).",
    )
    p.add_argument("--quantity", type=int, default=10, help="Quantity to set (default: 10).")
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="List documents that would be updated, without writing.",
    )
    args = p.parse_args()

    if args.quantity <= 0:
        print("ERROR: --quantity must be positive.", file=sys.stderr)
        return 2

    try:
        db = get_firestore_client()
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    col = db.collection(args.collection)
    stream = col.stream()
    payload = {"quantity": args.quantity}
    to_apply: list[tuple[firestore.DocumentReference, dict]] = []
    for snap in stream:
        to_apply.append((snap.reference, payload))
        if args.dry_run:
            print(f"would update {args.collection}/{snap.id!r} -> quantity={args.quantity}")
    if args.dry_run:
        print(f"DRY RUN: {len(to_apply)} document(s).")
        return 0
    if not to_apply:
        print("No documents found.")
        return 0
    _commit_batches(db, to_apply)
    print(f"Updated {len(to_apply)} document(s) in {args.collection!r} to quantity={args.quantity}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
