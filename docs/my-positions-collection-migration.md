# `my_positions_old` → deterministic canonical `my_positions`

Firestore cannot rename documents. Typical sequence:

1. Move legacy random-id rows under **`my_positions_old`** (copy/export/remove as fits your project).
2. Run **`migrate_my_positions_collection.py`** with **default** **`--source my_positions_old`** and **`--dest my_positions`** so canonical documents use deterministic ids keyed by ``created_at_utc``.
3. Deploy **rules**, **indexes**, and this codebase — constants are **`MY_POSITIONS_COLLECTION = "my_positions"`** and **`MY_POSITIONS_COLLECTION_LEGACY_ARCHIVE = "my_positions_old"`**.

Bundled helper (**never deletes** the `--source` collection):

- [`migrate_my_positions_collection.py`](../scripts/migrate_my_positions_collection.py)

Id format aligns with **`utc_datetime_lex_id`** in [`../src/signals_bot/storage/firestore.py`](../src/signals_bot/storage/firestore.py).

## Safety checklist

1. Export backup optional but recommended before large writes.
2. Run **`--dry-run`** first; fix every WARN (missing/unparseable ``created_at_utc``).
3. **`GOOGLE_APPLICATION_CREDENTIALS`** must target the intended project.
4. Run **`--execute`** only after dry-run output looks correct.
5. Console-spot-check counts: archive **`my_positions_old`** vs canonical **`my_positions`**, including nested **`checks`**.
6. Deploy **`firebase deploy --only firestore:rules,firestore:indexes`** after data is in **`my_positions`**.

## Commands (defaults: `my_positions_old` → `my_positions`)

```bash
# Plan only (no writes)
PYTHONPATH=./src python scripts/migrate_my_positions_collection.py \
  --source my_positions_old \
  --dest my_positions \
  --dry-run

# Apply + optional manifest of old→new top-level ids
PYTHONPATH=./src python scripts/migrate_my_positions_collection.py \
  --source my_positions_old \
  --dest my_positions \
  --execute \
  --manifest data/my_positions_id_map.json
```

## Promotion script (Firestore “rename”: archive + wipe legacy + promote staging)

Firestore has no native collection rename. To move **`my_positions` → `my_positions_old`** and **`my_positions_new` → `my_positions`** (full document trees including subcollections), use:

[`firestore_promote_my_positions_collections.py`](../scripts/firestore_promote_my_positions_collections.py)

**Phases:**

1. Deep copy **`--legacy` → `--archive`** (default `my_positions` → `my_positions_old`; use `--on-archive-clash abort|skip` if IDs collide).
2. **`recursive_delete`** on **`--legacy`** (destructive — requires **`--execute --i-understand-destructive`**).
3. Deep copy **`--staging` → `--canonical`** (default `my_positions_new` → `my_positions`).
4. Optional: delete **`--staging`** with **`--delete-staging`** and **`--i-understand-delete-staging`**.

If **`--legacy` and `--canonical` are the same collection id** (`my_positions`), Phase 3 runs only after Phase 2 in execute mode; **`--dry-run`** treats canonical as empty for clash detection after the planned Phase 2 wipe.

```bash
# Inspect only (counts and planned steps)
PYTHONPATH=./src python scripts/firestore_promote_my_positions_collections.py --dry-run

# Actually copy, delete legacy, promote staging — read script help before running
PYTHONPATH=./src python scripts/firestore_promote_my_positions_collections.py \
  --execute --i-understand-destructive
```

```bash
# Also remove staging after promotion
PYTHONPATH=./src python scripts/firestore_promote_my_positions_collections.py \
  --execute --i-understand-destructive \
  --delete-staging --i-understand-delete-staging
```

## Edge cases

- Duplicate ``created_at_utc``: suffix ``_dup1``, ``_dup2``.
- Missing field: id ``_missing_created_at_<sanitized_legacy_id>`` plus WARN.
- Subtrees deeper than ``--max-depth`` (default 32) abort.
