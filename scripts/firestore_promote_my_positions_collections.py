#!/usr/bin/env python3
"""Firestore “rename” for positions collections (copy + recursive delete).

End state matches a manual Firebase rename:

- **``my_positions_old``** — archive copy of former auto-id **`my_positions`** (same ids, deep copy incl. ``checks``).
- **``my_positions``** — copy of former **`my_positions_new`** staging (same ids, deep copy).

This does **not** change document fields; it moves trees between collection paths. Run **``--dry-run``**
before **``--execute``**. Destructive steps require **``--i-understand-destructive``**.

Typical CLI (repo root, ``GOOGLE_APPLICATION_CREDENTIALS`` in ``.env``):

  PYTHONPATH=./src python scripts/firestore_promote_my_positions_collections.py --dry-run

  PYTHONPATH=./src python scripts/firestore_promote_my_positions_collections.py \\
      --execute --i-understand-destructive

  PYTHONPATH=./src python scripts/firestore_promote_my_positions_collections.py \\
      --execute --i-understand-destructive --delete-staging --i-understand-delete-staging
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from dotenv import load_dotenv

from signals_bot.storage.firestore import (
    MY_POSITIONS_COLLECTION,
    MY_POSITIONS_COLLECTION_LEGACY_ARCHIVE,
    MY_POSITIONS_STAGING_COLLECTION,
    get_firestore_client,
)
from signals_bot.storage.firestore_doc_tree import deep_copy_document_tree


_DEFAULT_LEGACY = "my_positions"
MAX_DEPTH_DEFAULT = 32


def _top_level_docs(coll) -> list[str]:
    return [s.id for s in coll.stream()]


def main() -> int:
    p = argparse.ArgumentParser(
        description=(
            "Archive legacy my_positions → my_positions_old, "
            "then promote my_positions_new → my_positions (deep copy); optional delete staging."
        )
    )
    p.add_argument(
        "--legacy",
        default=_DEFAULT_LEGACY,
        help=f"Current random-id collection to archive (default: {_DEFAULT_LEGACY!r})",
    )
    p.add_argument(
        "--archive",
        default=MY_POSITIONS_COLLECTION_LEGACY_ARCHIVE,
        help=f"Destination archive collection (default: {MY_POSITIONS_COLLECTION_LEGACY_ARCHIVE!r})",
    )
    p.add_argument(
        "--staging",
        default=MY_POSITIONS_STAGING_COLLECTION,
        help=f"Staging collection with deterministic ids (default: {MY_POSITIONS_STAGING_COLLECTION!r})",
    )
    p.add_argument(
        "--canonical",
        default=MY_POSITIONS_COLLECTION,
        help=f"Final canonical collection name (default: {MY_POSITIONS_COLLECTION!r})",
    )
    grp = p.add_mutually_exclusive_group(required=True)
    grp.add_argument("--dry-run", action="store_true", help="Plan and count trees only.")
    grp.add_argument(
        "--execute",
        action="store_true",
        help="Perform copies and deletes (requires --i-understand-destructive for deletes).",
    )
    p.add_argument(
        "--i-understand-destructive",
        action="store_true",
        help="Required with --execute: allow recursive deletes of legacy/staging roots.",
    )
    p.add_argument(
        "--delete-staging",
        action="store_true",
        help="After promotion, recursively delete --staging.",
    )
    p.add_argument(
        "--i-understand-delete-staging",
        action="store_true",
        help="Required with --execute --delete-staging.",
    )
    p.add_argument(
        "--on-archive-clash",
        choices=("abort", "skip"),
        default="abort",
        help="If archive already has same top-level doc id as legacy (default: abort).",
    )
    p.add_argument("--max-depth", type=int, default=MAX_DEPTH_DEFAULT, help="Subcollection recursion cap")

    args = p.parse_args()

    if args.legacy == args.archive:
        print("ERROR: --legacy and --archive must differ.", file=sys.stderr)
        return 2
    if args.staging == args.canonical:
        print("ERROR: --staging and --canonical must differ.", file=sys.stderr)
        return 2

    if args.execute and not args.i_understand_destructive:
        print(
            "ERROR: --execute requires --i-understand-destructive (recursive deletes wipe legacy paths).",
            file=sys.stderr,
        )
        return 2

    if args.delete_staging and args.execute and not args.i_understand_delete_staging:
        print(
            "ERROR: --delete-staging with --execute requires --i-understand-delete-staging",
            file=sys.stderr,
        )
        return 2

    dry = args.dry_run
    write = args.execute is True and not dry

    load_dotenv(ROOT / ".env", override=False)
    db = get_firestore_client()

    legacy_coll = db.collection(args.legacy)
    archive_coll = db.collection(args.archive)
    staging_coll = db.collection(args.staging)
    canonical_coll = db.collection(args.canonical)

    print(f"Legacy (source archive copy):      {args.legacy!r}")
    print(f"Archive (dest for legacy copy):    {args.archive!r}")
    print(f"Staging (source for promotion):    {args.staging!r}")
    print(f"Canonical (dest for staging copy): {args.canonical!r}")
    print()

    # --- Phase 1: legacy → archive ---
    legacy_ids = _top_level_docs(legacy_coll)
    clashes: list[tuple[str, str]] = []
    for lid in legacy_ids:
        if archive_coll.document(lid).get().exists:
            clashes.append((lid, f"{args.archive}/{lid}"))

    if clashes:
        print(f"Phase 1: {len(legacy_ids)} top-level legacy doc(s).")
        print(f"  Archive clashes (same doc id already exists): {len(clashes)}")
        for a, p in clashes[:25]:
            print(f"    {a} exists at {p}")
        if len(clashes) > 25:
            print(f"    … +{len(clashes) - 25} more")
        if args.on_archive_clash == "abort":
            print(
                "\nERROR: Resolve clashes (rename/delete archive docs), or rerun with "
                "`--on-archive-clash skip` to copy only non-clashing docs.",
                file=sys.stderr,
            )
            return 3
        print("With --on-archive-clash skip: will skip clashing docs only.")

    phase1_written = 0
    skipped = set(c[0] for c in clashes) if args.on_archive_clash == "skip" else set()

    for lid in legacy_ids:
        if lid in skipped:
            print(f"  SKIP clash {lid}")
            continue
        src_ref = legacy_coll.document(lid)
        dst_ref = archive_coll.document(lid)
        ctr = Counter(documents=0)
        deep_copy_document_tree(
            src_ref,
            dst_ref,
            write=write,
            ctr=ctr,
            depth=0,
            max_depth=args.max_depth,
        )
        phase1_written += ctr["documents"]
        print(f"  Phase 1 copied tree {lid} → {args.archive}/{lid} ({ctr['documents']} doc nodes)")

    if not legacy_ids:
        print("Phase 1: legacy collection empty — nothing to copy to archive.")

    print(f"\nPhase 1 total doc writes (all nodes incl. nested): ~{phase1_written}\n")

    # --- Phase 2: delete legacy root collection ---
    if legacy_ids:
        if dry:
            print(
                f"Phase 2 (dry-run): would recursive_delete(collection {args.legacy!r}) "
                f"including all docs and subcollections."
            )
        else:
            print(f"Phase 2: recursive_delete({args.legacy!r}) …")
            n_del = db.recursive_delete(legacy_coll)
            print(f"Phase 2 done (~{n_del} delete ops reported by SDK).")
    else:
        print("Phase 2: skipped (legacy empty).")

    print()

    # --- Phase 3: staging → canonical ---
    staging_ids = _top_level_docs(staging_coll)
    pretend_canonical_cleared = (
        dry
        and legacy_ids
        and args.legacy == args.canonical
    )
    if pretend_canonical_cleared:
        print(
            "(dry-run) Treating canonical collection as empty (same id as --legacy; Phase 2 would clear it).",
        )
        pre_canonical: list[str] = []
    else:
        pre_canonical = _top_level_docs(canonical_coll)

    if pre_canonical and staging_ids:
        print(
            f"ERROR: canonical {args.canonical!r} already has {len(pre_canonical)} top-level doc(s). "
            "Empty it first (after backup) before promoting staging.",
            file=sys.stderr,
        )
        return 4

    phase3_writes = 0
    if not staging_ids:
        print("Phase 3: staging empty — nothing to copy to canonical.")
    else:
        for sid in staging_ids:
            sref = staging_coll.document(sid)
            dref = canonical_coll.document(sid)
            ctr = Counter(documents=0)
            deep_copy_document_tree(
                sref,
                dref,
                write=write,
                ctr=ctr,
                depth=0,
                max_depth=args.max_depth,
            )
            phase3_writes += ctr["documents"]
            print(
                f"  Phase 3 copied tree {sid} → {args.canonical}/{sid} ({ctr['documents']} doc nodes)"
            )
        print(f"\nPhase 3 total doc writes (all nodes): ~{phase3_writes}\n")

    # --- Phase 4: delete staging ---
    if args.delete_staging:
        if staging_ids:
            if dry:
                print(
                    f"Phase 4 (dry-run): would recursive_delete(collection {args.staging!r})"
                )
            else:
                print(f"Phase 4: recursive_delete({args.staging!r}) …")
                db.recursive_delete(staging_coll)
                print("Phase 4 done.")
        else:
            print("Phase 4: staging empty — skipped.")
    elif dry:
        print("Phase 4: (--delete-staging not set — staging collection left as-is)")
    print()
    print("Finished. Deploy firestore.rules + indexes after data matches your app.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
