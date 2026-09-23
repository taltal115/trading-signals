#!/usr/bin/env python3
"""Quick diagnostic tool to check why a signal's AI gate failed."""

import sys
import os
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
os.chdir(Path(__file__).parent.parent)

from dotenv import load_dotenv
load_dotenv()

from google.cloud import firestore
from signals_bot.storage.firestore import get_firestore_client


def analyze_ai_gate_failure(ticker: str, limit: int = 10):
    """
    Analyze why a ticker's AI gate failed.
    
    AI gate passes when ALL of these are true:
    1. Decision = "BUY"
    2. Total score >= entry_min_total (default: 70)
    3. Conviction >= entry_min_conviction (default: 0.7)
    4. Direction = "long" (not "short")
    
    From config.yaml:
        ai:
          entry_min_total: 70
          entry_min_conviction: 0.7
    """
    db = get_firestore_client()
    
    # Query recent runs for this ticker
    runs = db.collection('signals').order_by(
        'run_ts', 
        direction=firestore.Query.DESCENDING
    ).limit(limit).stream()
    
    found_count = 0
    print(f"\n{'='*80}")
    print(f"Searching for {ticker} in the last {limit} runs...")
    print(f"{'='*80}\n")
    
    for run in runs:
        run_data = run.to_dict()
        run_id = run.id
        run_ts = run_data.get('run_ts')
        tickers = run_data.get('tickers', [])
        
        for ticker_data in tickers:
            if ticker_data.get('symbol') != ticker:
                continue
                
            found_count += 1
            print(f"\n{'='*80}")
            print(f"FOUND: {ticker} in run {run_id}")
            print(f"Run timestamp: {run_ts}")
            print(f"{'='*80}")
            
            signal_type = ticker_data.get('signal', 'UNKNOWN')
            ai_gate = ticker_data.get('ai_gate', 'pending')
            confidence = ticker_data.get('confidence', 0)
            
            print(f"\n📊 SIGNAL STATUS:")
            print(f"  Signal type: {signal_type}")
            print(f"  AI gate: {ai_gate}")
            print(f"  Technical confidence: {confidence}")
            
            # Check if there's a recommendation
            rec = ticker_data.get('recommendation', {})
            if not rec:
                print(f"\n⚠️  NO RECOMMENDATION DATA")
                print(f"  Likely reasons:")
                print(f"    - Signal is still ai_gate=pending (not yet evaluated)")
                print(f"    - Evaluation failed or was skipped")
                continue
            
            # Analyze the recommendation
            decision = rec.get('decision', 'UNKNOWN')
            headline = rec.get('headline', '')
            scores = rec.get('scores', {})
            total_score = scores.get('total', 0)
            technical_score = scores.get('technical', 0)
            ai_score = scores.get('ai', 0)
            
            detail = rec.get('detail', {})
            conviction = detail.get('conviction', 0)
            direction = detail.get('direction', 'unknown')
            risk_reward = detail.get('risk_reward_ratio', 0)
            
            print(f"\n🤖 AI RECOMMENDATION:")
            print(f"  Decision: {decision}")
            print(f"  Headline: {headline[:100]}")
            
            print(f"\n📈 SCORES:")
            print(f"  Total Score: {total_score:.2f}")
            print(f"  Technical: {technical_score:.2f}")
            print(f"  AI Component: {ai_score:.2f}")
            
            print(f"\n💡 AI DETAILS:")
            print(f"  Conviction: {conviction:.3f}")
            print(f"  Direction: {direction}")
            print(f"  Risk/Reward Ratio: {risk_reward:.2f}")
            
            # Analyze AI gate decision
            print(f"\n🚦 AI GATE ANALYSIS:")
            print(f"  Status: {ai_gate.upper()}")
            
            # Check each gate condition
            entry_min_total = 70
            entry_min_conviction = 0.7
            
            checks = {
                "Decision is BUY": decision == "BUY",
                f"Total score >= {entry_min_total}": total_score >= entry_min_total,
                f"Conviction >= {entry_min_conviction}": conviction >= entry_min_conviction,
                "Direction is long": direction.lower().startswith("long"),
            }
            
            all_passed = all(checks.values())
            
            for check_name, passed in checks.items():
                status = "✅ PASS" if passed else "❌ FAIL"
                print(f"  {status}: {check_name}")
                if not passed:
                    if "Total score" in check_name:
                        print(f"      → Score is {total_score:.2f}, needs {entry_min_total}")
                    elif "Conviction" in check_name:
                        print(f"      → Conviction is {conviction:.3f}, needs {entry_min_conviction}")
                    elif "Decision" in check_name:
                        print(f"      → Decision is '{decision}', needs 'BUY'")
                    elif "Direction" in check_name:
                        print(f"      → Direction is '{direction}', needs 'long'")
            
            if all_passed and ai_gate != "passed":
                print(f"\n  ⚠️  WARNING: All conditions met but ai_gate={ai_gate}")
                print(f"      This shouldn't happen - possible data inconsistency")
            elif not all_passed and ai_gate == "passed":
                print(f"\n  ⚠️  WARNING: Conditions NOT met but ai_gate=passed")
                print(f"      This shouldn't happen - possible data inconsistency")
            
            # Show the "why"
            why = rec.get('why', '')
            if why:
                print(f"\n💬 AI REASONING:")
                print(f"  {why[:300]}")
                if len(why) > 300:
                    print(f"  ... (truncated)")
            
            # Show AI evals history
            ai_evals = ticker_data.get('ai_evals', [])
            if ai_evals:
                print(f"\n📝 AI EVALUATIONS: {len(ai_evals)} total")
                latest = ai_evals[-1]
                eval_ts = latest.get('eval_ts', 'unknown')
                print(f"  Latest eval: {eval_ts}")
    
    if found_count == 0:
        print(f"\n❌ {ticker} not found in the last {limit} runs")
        print(f"\nTry:")
        print(f"  1. Increase --limit to search more runs")
        print(f"  2. Check if the symbol is correct")
        print(f"  3. Verify the signal was generated recently")
    else:
        print(f"\n{'='*80}")
        print(f"Found {found_count} instance(s) of {ticker}")
        print(f"{'='*80}\n")


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Check why a signal's AI gate failed",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python scripts/check_signal_ai_gate.py SECZ
  python scripts/check_signal_ai_gate.py GTLB --limit 20
  
AI Gate Rules (from config.yaml):
  - entry_min_total: 70 (total score threshold)
  - entry_min_conviction: 0.7 (conviction threshold)
  - Decision must be "BUY"
  - Direction must be "long"
        """
    )
    parser.add_argument('ticker', help='Ticker symbol to check (e.g., SECZ)')
    parser.add_argument('--limit', type=int, default=10, 
                       help='Number of recent runs to check (default: 10)')
    
    args = parser.parse_args()
    
    try:
        analyze_ai_gate_failure(args.ticker.upper(), args.limit)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
