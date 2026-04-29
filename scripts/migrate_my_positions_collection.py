#!/usr/bin/env python3
"""Copy ``my_positions_old`` (archive) → canonical ``my_positions`` with deterministic top-level document ids.

**Top-level ids** derive from ``created_at_utc`` (same lexical pattern as signal run docs:
``YYYY-MM-DDTHH-MM-SS.ffffffZ``). Identical timestamps get ``_dup1``, ``_dup2``, …

All field values (including ``null``) and **subcollections** (e.g. ``checks``) copy
recursively; nested document ids under each subcollection are preserved.

This script **never deletes** the source collection. Run ``--dry-run`` before ``--execute``.

Typical use after moving legacy bundles: archive auto-id rows live under ``my_positions_old``;
deterministic migrated rows are written under ``my_positions``. Defaults match that flow.

Usage (repo root, ``GOOGLE_APPLICATION_CREDENTIALS`` in ``.env``):

  PYTHONPATH=./src python scripts/migrate_my_positions_collection.py \\
    --source my_positions_old --dest my_positions --dry-run

  PYTHONPATH=./src python scripts/migrate_my_positions_collection.py \\
    --source my_positions_old --dest my_positions --execute --manifest migration_map.json
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from dotenv import load_dotenv

from signals_bot.storage.firestore_doc_tree import deep_copy_document_tree

from signals_bot.storage.firestore import (  # noqa: E402
    MY_POSITIONS_COLLECTION,
    MY_POSITIONS_COLLECTION_LEGACY_ARCHIVE,
    get_firestore_client,
    utc_datetime_lex_id,
)

MAX_DEPTH_DEFAULT = 32


def _coerce_created_at_utc(raw: Any) -> datetime | None:
    """Parse ``created_at_utc``: ISO string or ``datetime`` (Firestore timestamp types)."""
    if raw is None:
        return None
    if isinstance(raw, datetime):
        if raw.tzinfo is None:
            return raw.replace(tzinfo=timezone.utc)
        return raw.astimezone(timezone.utc)
    s = str(raw).strip()
    if not s:
        return None
    try:
        tnorm = s.replace("Z", "+00:00") if s.endswith("Z") else s
        dt = datetime.fromisoformat(tnorm)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def _fallback_doc_id_when_no_created_at(legacy_id: str) -> str:
    safe = "".join(c for c in legacy_id if c.isalnum() or c in "_-")[:380]
    if not safe:
        safe = "unknown"
    return f"_missing_created_at_{safe}"


def main() -> int:
    p = argparse.ArgumentParser(
        description=(
            "Copy archived rows from --source into canonical `--dest` with ids from "
            f"created_at_utc (default: {MY_POSITIONS_COLLECTION_LEGACY_ARCHIVE!r} → {MY_POSITIONS_COLLECTION!r})."
        )
    )
    p.add_argument(
        "--source",
        default=MY_POSITIONS_COLLECTION_LEGACY_ARCHIVE,
        help=f"Archive collection id (default: {MY_POSITIONS_COLLECTION_LEGACY_ARCHIVE})",
    )
    p.add_argument(
        "--dest",
        default=MY_POSITIONS_COLLECTION,
        help=f"Destination collection id (default: {MY_POSITIONS_COLLECTION})",
    )
    p.add_argument(
        "--created-field",
        default="created_at_utc",
        help="Top-level field for deterministic ids (default: created_at_utc)",
    )

    grp = p.add_mutually_exclusive_group(required=True)
    grp.add_argument("--dry-run", action="store_true", help="Print mapping only; recurse-count each subtree without writes.")
    grp.add_argument("--execute", action="store_true", help="Write full document trees to destination.")
    p.add_argument(
        "--manifest",
        default="",
        help='With --execute: write JSON mapping old id -> new id (top-level only) to this path.',
    )
    p.add_argument("--max-depth", type=int, default=MAX_DEPTH_DEFAULT, help=f"Subcollection recursion cap (default {MAX_DEPTH_DEFAULT})")

    args = p.parse_args()
    manifest_path = (args.manifest or "").strip()

    load_dotenv(ROOT / ".env", override=False)
    db = get_firestore_client()
    src_coll = db.collection(args.source)
    dest_coll = db.collection(args.dest)

    used_ids: set[str] = set()
    mapping_lines: list[tuple[str, str, str]] = []
    mapping_json: dict[str, str] = {}

    for snap in src_coll.stream():
        data = snap.to_dict() or {}
        dt = _coerce_created_at_utc(data.get(args.created_field))

        if dt is None:
            nid_base = _fallback_doc_id_when_no_created_at(snap.id)
            warn = f"WARN: bad/missing {args.created_field} for doc {snap.id!r}; using {nid_base}"
        else:
            nid_base = utc_datetime_lex_id(dt)
            warn = ""

        nid = nid_base
        dup_k = 0
        while nid in used_ids:
            dup_k += 1
            nid = f"{nid_base}_dup{dup_k}"
        used_ids.add(nid)

        mapping_lines.append((snap.id, nid, warn))
        mapping_json[snap.id] = nid

    print(f"Top-level documents planned: {len(mapping_lines)}\n")

    subtree_doc_totals = 0
    for old_id, new_id, warn in mapping_lines:
        ctr = Counter(documents=0)
        src_ref = src_coll.document(old_id)
        dst_ref = dest_coll.document(new_id)
        deep_copy_document_tree(
            src_ref,
            dst_ref,
            write=(args.execute is True),
            ctr=ctr,
            depth=0,
            max_depth=args.max_depth,
        )
        subtree_doc_totals += ctr["documents"]
        line = f"  {old_id} → {new_id}  ({ctr['documents']} doc(s) in tree)"
        print(line + (f"\n    {warn}" if warn else ""))

    print(f"\nGrand total documents across trees (roots + descendants): {subtree_doc_totals}")

    if args.dry_run:
        print("\nDry-run finished — no writes. Review above, export Firestore backup if unsure, then rerun with --execute.")
        return 0

    assert args.execute is True

    if manifest_path:
        out = Path(manifest_path)
        if out.parent.as_posix() not in ("", "."):
            out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(mapping_json, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"\nManifest written: {out.resolve()}")

    print("\nExecute finished. Source archive was not modified. Verify counts in Firebase Console when ready.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
