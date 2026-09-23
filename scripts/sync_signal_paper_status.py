#!/usr/bin/env python3
"""Sync paper_status on signals to match actual position status.

When monitor_open_positions closes a paper position, it only updates my_positions.
This script ensures the signals collection's paper_status field stays in sync.
"""

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from google.cloud import firestore
from signals_bot.storage.firestore import (
    SIGNALS_COLLECTION,
    MY_POSITIONS_COLLECTION,
    get_firestore_client,
)


def sync_signal_paper_status(
    db: firestore.Client,
    signal_doc_id: str,
    ticker: str,
    signal_index: int,
    new_status: str,
    dry_run: bool = True,
) -> bool:
    """Update paper_status on a specific signal to match position status."""
    
    ref = db.collection(SIGNALS_COLLECTION).document(signal_doc_id.strip())
    sym = ticker.strip().upper()
    
    @firestore.transactional
    def _do(transaction, run_ref):  # type: ignore[no-untyped-def]
        snap = run_ref.get(transaction=transaction)
        if not snap.exists:
            print(f"  ❌ Signal run {signal_doc_id} not found")
            return False
            
        data = snap.to_dict() or {}
        sigs = data.get("signals")
        if not isinstance(sigs, list):
            print(f"  ❌ No signals array in {signal_doc_id}")
            return False
            
        if signal_index >= len(sigs):
            print(f"  ❌ Signal index {signal_index} out of range (len={len(sigs)})")
            return False
        
        sig = sigs[signal_index]
        if not isinstance(sig, dict):
            print(f"  ❌ Signal at index {signal_index} is not a dict")
            return False
            
        sig_ticker = str(sig.get("ticker", "")).strip().upper()
        if sig_ticker != sym:
            print(f"  ❌ Ticker mismatch: expected {sym}, found {sig_ticker}")
            return False
        
        old_status = sig.get("paper_status")
        if old_status == new_status:
            print(f"  ℹ️  Already {new_status}, no change needed")
            return False
        
        print(f"  📝 Updating paper_status: {old_status} → {new_status}")
        
        if not dry_run:
            # Update the signal
            sigs[signal_index]["paper_status"] = new_status
            sigs[signal_index]["paper_status_synced_at_utc"] = datetime.now(timezone.utc).isoformat()
            transaction.update(run_ref, {"signals": sigs})
            print(f"  ✅ Updated successfully")
        else:
            print(f"  ⏸️  DRY RUN - no changes made")
        
        return True
    
    txn = db.transaction()
    try:
        return _do(txn, ref)
    except Exception as e:
        print(f"  ❌ Error: {e}")
        return False


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sync signal paper_status to match position status"
    )
    parser.add_argument(
        "--since",
        default="2026-09-17",
        help="Start date (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--until",
        default="2026-09-18",
        help="End date (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be updated without making changes",
    )
    args = parser.parse_args()
    
    db = get_firestore_client()
    
    print(f"Scanning signals from {args.since} to {args.until}...")
    if args.dry_run:
        print("🔍 DRY RUN MODE - no changes will be made\n")
    
    # Query signals in the date range
    query = (
        db.collection(SIGNALS_COLLECTION)
        .where("asof_date", ">=", args.since)
        .where("asof_date", "<=", args.until)
    )
    docs = list(query.stream())
    
    print(f"Found {len(docs)} signal run documents\n")
    
    updated_count = 0
    mismatch_count = 0
    
    for doc in docs:
        data = doc.to_dict()
        asof = data.get("asof_date")
        signals = data.get("signals", [])
        
        print(f"=== Run: {doc.id} ({asof}) ===")
        
        for i, sig in enumerate(signals):
            if not isinstance(sig, dict):
                continue
            
            ticker = sig.get("ticker")
            paper_status = sig.get("paper_status")
            paper_pos_id = sig.get("paper_position_id")
            
            # Only check signals with paper positions
            if not paper_pos_id:
                continue
            
            # Get the position status
            pos_ref = db.collection(MY_POSITIONS_COLLECTION).document(paper_pos_id)
            pos_snap = pos_ref.get()
            
            if not pos_snap.exists:
                continue
            
            pos_data = pos_snap.to_dict()
            pos_status = pos_data.get("status")
            
            # Check for mismatch
            if pos_status == "closed" and paper_status != "closed":
                mismatch_count += 1
                exit_origin = pos_data.get("exit_origin", "unknown")
                closed_at = pos_data.get("closed_at_utc", "unknown")
                
                print(f"\n[{i}] {ticker}:")
                print(f"  Current paper_status: {paper_status}")
                print(f"  Position status: {pos_status}")
                print(f"  Exit origin: {exit_origin}")
                print(f"  Closed at: {closed_at}")
                
                # Sync it
                if sync_signal_paper_status(
                    db=db,
                    signal_doc_id=doc.id,
                    ticker=ticker,
                    signal_index=i,
                    new_status="closed",
                    dry_run=args.dry_run,
                ):
                    updated_count += 1
        
        print()
    
    print("\n=== SUMMARY ===")
    print(f"Total mismatches found: {mismatch_count}")
    print(f"Total signals {'that would be ' if args.dry_run else ''}updated: {updated_count}")
    
    if args.dry_run and updated_count > 0:
        print(f"\nTo apply these changes, run without --dry-run:")
        print(f"  PYTHONPATH=./src python scripts/sync_signal_paper_status.py --since {args.since} --until {args.until}")
    
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
