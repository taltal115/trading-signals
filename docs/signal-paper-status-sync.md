# Signal Paper Status Synchronization

## Problem

There is a **data synchronization gap** between two related status fields:

1. **`signals` collection** → `signals[].paper_status` field
   - Values: `"none"`, `"pending"`, `"open"`, `"exit_advised"`, `"closed"`
   - Purpose: Tracks paper position status for display in the Signals UI

2. **`my_positions` collection** → `status` field
   - Values: `"open"`, `"closed"`
   - Purpose: Tracks the actual position lifecycle

### When the Gap Occurs

When `scripts/monitor_open_positions.py` detects a target or stop hit:
- ✅ It updates `my_positions/{doc_id}.status = "closed"`
- ❌ It does **NOT** update the corresponding `signals/{run_id}.signals[].paper_status`

This creates an inconsistency where:
- The position document shows `status: "closed"`
- The signal document still shows `paper_status: "open"` (or "exit_advised")
- The Signals page UI displays stale status information

## Code Locations

### Where positions get closed:
- `scripts/monitor_open_positions.py` line ~889
  ```python
  patch.update({
      "status": "closed",
      "exit_price": lc,
      # ... other fields
  })
  ```

### Where signals get updated:
- `src/signals_bot/storage/firestore.py`:
  - `write_buy_signals()` - initial `paper_status` when position opens
  - `mirror_holding_advice_to_signal()` - updates when holding advice received
  - `close_signal_paper_position()` - manual close for filtered/skipped entries

### Missing link:
- **No automatic sync from position status → signal paper_status**

## Solutions

### 1. Diagnostic Script (Check for Mismatches)

```bash
PYTHONPATH=./src python scripts/diagnose_signal_status.py
```

This will:
- Query signals from Sep 17-18 (or any date range you specify)
- Check each signal's `paper_status` against the actual position `status`
- Report any mismatches

### 2. Sync Script (Fix Existing Mismatches)

```bash
# Dry run first (recommended)
PYTHONPATH=./src python scripts/sync_signal_paper_status.py \
  --since 2026-09-17 --until 2026-09-18 --dry-run

# Apply changes
PYTHONPATH=./src python scripts/sync_signal_paper_status.py \
  --since 2026-09-17 --until 2026-09-18
```

This will:
- Find all signals where position is closed but `paper_status` is not
- Update `paper_status` to "closed"
- Add `paper_status_synced_at_utc` timestamp

### 3. Prevention (Future Enhancement)

**Option A: Update monitor script to sync immediately**

Modify `scripts/monitor_open_positions.py` to call a sync function when closing positions:

```python
# After setting status="closed" on position
from signals_bot.storage.firestore import sync_signal_paper_status_from_position

sync_signal_paper_status_from_position(
    db=db,
    signal_doc_id=data.get("signal_doc_id"),
    ticker=ticker,
    new_status="closed",
)
```

**Option B: Periodic sync job**

Run the sync script daily via cron or GitHub Actions to catch any stragglers:

```yaml
# .github/workflows/sync-signal-status.yml
name: Sync Signal Paper Status
on:
  schedule:
    - cron: "0 2 * * *"  # Daily at 2 AM UTC
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Setup Python
        uses: actions/setup-python@v4
        with:
          python-version: "3.11"
      - name: Install deps
        run: pip install -r requirements.txt
      - name: Sync status
        run: |
          PYTHONPATH=./src python scripts/sync_signal_paper_status.py \
            --since $(date -d '7 days ago' +%Y-%m-%d) \
            --until $(date +%Y-%m-%d)
```

**Option C: Real-time Firestore trigger**

Create a Cloud Function that watches `my_positions` for status changes and syncs to signals:

```python
@firestore_function.on_document_updated(document="my_positions/{doc_id}")
def sync_position_to_signal(event: Event[Change[DocumentSnapshot]]):
    """Mirror position status changes back to signals collection."""
    # ... implementation
```

## Recommendation

For immediate fix:
1. ✅ Run diagnostic script to identify the 5 signals from Sep 17-18
2. ✅ Run sync script to fix them

For long-term solution:
- **Recommended: Option A** (update monitor script)
  - Most reliable: happens immediately when position closes
  - No delay, no extra jobs to maintain
  - Keeps data in sync at the source

## Related Files

- `scripts/diagnose_signal_status.py` - diagnostic tool
- `scripts/sync_signal_paper_status.py` - sync tool
- `scripts/monitor_open_positions.py` - where positions get closed
- `src/signals_bot/storage/firestore.py` - Firestore operations
- `backend/src/signals/signal-lifecycle.service.ts` - reads `paper_status` for UI

## See Also

- [Bot Logic and Strategy](./bot-logic-and-strategy.md)
- [AI Signal Pipeline](./ai-signal-pipeline/README.md)
- August 2026 research on actionable signals
