#!/usr/bin/env python3
"""Diagnose signal paper_status synchronization issues.

Check if paper positions are closed in my_positions but still show open/missing
paper_status in the signals collection.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from signals_bot.storage.firestore import (
    SIGNALS_COLLECTION,
    MY_POSITIONS_COLLECTION,
    get_firestore_client,
)


def main() -> int:
    db = get_firestore_client()
    
    # Query signals from Sep 17-18
    print("Querying signals from Sep 17-18, 2026...")
    query = (
        db.collection(SIGNALS_COLLECTION)
        .where("asof_date", ">=", "2026-09-17")
        .where("asof_date", "<=", "2026-09-18")
    )
    docs = list(query.stream())
    
    print(f"Found {len(docs)} signal run documents\n")
    
    mismatches = []
    
    for doc in docs:
        data = doc.to_dict()
        asof = data.get("asof_date")
        signals = data.get("signals", [])
        
        print(f"=== Run: {doc.id} ({asof}) ===")
        print(f"Total signals: {len(signals)}\n")
        
        for i, sig in enumerate(signals):
            if not isinstance(sig, dict):
                continue
                
            ticker = sig.get("ticker")
            action = sig.get("action")
            paper_status = sig.get("paper_status")
            ai_gate = sig.get("ai_gate")
            paper_pos_id = sig.get("paper_position_id")
            
            print(f"  [{i}] {ticker}:")
            print(f"      action: {action}")
            print(f"      paper_status: {paper_status}")
            print(f"      ai_gate: {ai_gate}")
            
            # If there's a paper position, check its status
            if paper_pos_id:
                pos_ref = db.collection(MY_POSITIONS_COLLECTION).document(paper_pos_id)
                pos_snap = pos_ref.get()
                
                if pos_snap.exists:
                    pos_data = pos_snap.to_dict()
                    pos_status = pos_data.get("status")
                    exit_origin = pos_data.get("exit_origin")
                    closed_at = pos_data.get("closed_at_utc")
                    
                    print(f"      position.status: {pos_status}")
                    
                    # Check for mismatch
                    if pos_status == "closed" and paper_status != "closed":
                        print(f"      ⚠️  MISMATCH: Position is closed but paper_status is '{paper_status}'")
                        print(f"      exit_origin: {exit_origin}")
                        print(f"      closed_at_utc: {closed_at}")
                        
                        mismatches.append({
                            "run_id": doc.id,
                            "ticker": ticker,
                            "signal_index": i,
                            "paper_status": paper_status,
                            "position_status": pos_status,
                            "exit_origin": exit_origin,
                            "closed_at_utc": closed_at,
                        })
                else:
                    print(f"      position: NOT FOUND (id={paper_pos_id})")
            
            print()
    
    if mismatches:
        print("\n=== SUMMARY OF MISMATCHES ===")
        print(f"Found {len(mismatches)} signals with status mismatches:\n")
        
        for m in mismatches:
            print(f"  {m['ticker']} (run: {m['run_id']}, index: {m['signal_index']})")
            print(f"    signal paper_status: {m['paper_status']}")
            print(f"    position status: {m['position_status']}")
            print(f"    exit_origin: {m['exit_origin']}")
            print(f"    closed_at_utc: {m['closed_at_utc']}")
            print()
        
        print("\nThese signals need their paper_status updated to 'closed'")
        print("to match the actual position status.")
    else:
        print("\n✅ No mismatches found - all signals are in sync!")
    
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
