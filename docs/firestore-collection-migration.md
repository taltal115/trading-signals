# Firestore collections: migrate / “rename”

Firestore cannot rename collections. You **copy documents** to the new collection id (often keeping the **same document id**), then **delete** the old collection’s documents when you are done.

This repo targets:

- **`signals`** — canonical bot runs (deterministic document ids).
- **`signals_old`** — archive of the former auto-id `signals` collection, if you keep it.

If your project still has **legacy `signals`** (auto ids) **and a separate collection** that holds deterministic canonical runs (not yet merged into the final `signals` name), use the steps below to end with canonical data in **`signals`** and legacy data in **`signals_old`**.

## Prerequisites

- Repo root, Python env with `google-cloud-firestore` installed (same as the bot).
- `.env` with **`GOOGLE_APPLICATION_CREDENTIALS`** pointing at your service account JSON.

## Recommended order

1. **Dry-run** copying legacy **`signals`** → **`signals_old`**  
   Checks counts and previews ids.

```bash
cd /path/to/trading-signals
PYTHONPATH=./src python scripts/firestore_copy_collection.py --from signals --to signals_old --dry-run
```

2. **Copy** legacy **`signals`** → **`signals_old`** (same document ids).

```bash
PYTHONPATH=./src python scripts/firestore_copy_collection.py --from signals --to signals_old
```

3. In Firebase Console (or CLI), **spot-check** a few docs under **`signals_old`** vs **`signals`**.

4. **Delete all documents** in **`signals`** so the name can be reused for canonical data  
   (**only** after step 3 looks good):

```bash
PYTHONPATH=./src python scripts/firestore_delete_collection_docs.py --collection signals --dry-run
PYTHONPATH=./src python scripts/firestore_delete_collection_docs.py --collection signals --execute --i-understand
```

5. **Copy** your **staging collection of deterministic runs** into **`signals`** (same document ids).  
   Replace `OLD_CANONICAL` with the actual collection id in your project (the one that held canonical runs before this merge):

```bash
PYTHONPATH=./src python scripts/firestore_copy_collection.py --from OLD_CANONICAL --to signals --dry-run
PYTHONPATH=./src python scripts/firestore_copy_collection.py --from OLD_CANONICAL --to signals
```

6. When you are satisfied **`signals`** is correct, **delete all documents** in **`OLD_CANONICAL`** (optional cleanup). Use the same id you used in step 5:

```bash
PYTHONPATH=./src python scripts/firestore_delete_collection_docs.py --collection OLD_CANONICAL --dry-run
PYTHONPATH=./src python scripts/firestore_delete_collection_docs.py --collection OLD_CANONICAL --execute --i-understand
```

7. Deploy security rules if you changed them:

```bash
firebase deploy --only firestore:rules
```

## Other tools in this repo

- **[`scripts/migrate_signals_old_to_signals.py`](../scripts/migrate_signals_old_to_signals.py)** — copy **`signals_old`** → **`signals`** while **recomputing** deterministic ids from `asof_date` / `ts_utc` / `run_id`. Use if you need id regeneration instead of **preserving ids from a straight copy** (step 5).

## Limits and caveats

- These scripts copy **top-level document fields** only. If you ever add **subcollections** under signal run documents, extend the tooling or delete them manually.
- Firestore batch limits mean large collections are committed in chunks (scripts handle this).
- Always run **`--dry-run`** first on copy/delete helpers.
