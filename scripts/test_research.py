#!/usr/bin/env python3
"""Standalone test script for Massive.com AI research layer.

Usage:
    python scripts/test_research.py AAPL
    python scripts/test_research.py TSLA --model gpt-5.4-mini
    python scripts/test_research.py NVDA --news-days 14 --verbose
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from dotenv import load_dotenv

from signals_bot.research import StockResearcher, research_stock


def setup_logging(verbose: bool = False) -> logging.Logger:
    """Setup logging configuration."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(levelname)s [%(name)s] %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )
    return logging.getLogger("test_research")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Test Massive.com AI research layer",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("ticker", help="Stock ticker to research")
    parser.add_argument(
        "--model",
        default="gpt-4",
        help="OpenAI model to use (default: gpt-4)",
    )
    parser.add_argument(
        "--news-days",
        type=int,
        default=7,
        help="Days to look back for news (default: 7)",
    )
    parser.add_argument(
        "--news-limit",
        type=int,
        default=20,
        help="Max news articles (default: 20)",
    )
    parser.add_argument(
        "--price",
        type=float,
        default=100.0,
        help="Current stock price (default: 100.0)",
    )
    parser.add_argument(
        "--ret-5d",
        type=float,
        default=15.0,
        help="5-day return % (default: 15.0)",
    )
    parser.add_argument(
        "--ret-10d",
        type=float,
        default=25.0,
        help="10-day return % (default: 25.0)",
    )
    parser.add_argument(
        "--vol-ratio",
        type=float,
        default=3.5,
        help="Volume ratio vs 20-day avg (default: 3.5)",
    )
    parser.add_argument(
        "--technical-score",
        type=float,
        default=85.0,
        help="Technical score 0-100 (default: 85.0)",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Enable verbose logging",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output result as JSON",
    )
    parser.add_argument(
        "--no-ai",
        action="store_true",
        help="Skip AI synthesis, only fetch research data",
    )
    
    args = parser.parse_args()
    
    load_dotenv(REPO_ROOT / ".env", override=False)
    
    log = setup_logging(args.verbose)
    
    ticker = args.ticker.strip().upper()
    
    if not os.getenv("MASSIVE_API_KEY"):
        log.error("MASSIVE_API_KEY environment variable not set")
        log.info("Set it in .env file: MASSIVE_API_KEY=your_key_here")
        return 1
    
    if not args.no_ai and not os.getenv("OPENAI_API_KEY"):
        log.warning("OPENAI_API_KEY not set - AI synthesis will use stub responses")
    
    log.info("Researching %s with model %s", ticker, args.model)
    
    technical_metrics = {
        "current_price": args.price,
        "ret_5d": args.ret_5d,
        "ret_10d": args.ret_10d,
        "vol_ratio": args.vol_ratio,
        "technical_score": args.technical_score,
    }
    
    try:
        if args.no_ai:
            from signals_bot.research.context import build_research_context
            from signals_bot.research.massive_client import MassiveClient
            
            log.info("Fetching research data only (no AI synthesis)")
            massive_client = MassiveClient()
            context = build_research_context(
                ticker=ticker,
                massive_client=massive_client,
                news_days_back=args.news_days,
                news_limit=args.news_limit,
            )
            
            if args.json:
                print(json.dumps(context.to_dict(), indent=2, default=str))
            else:
                print("\n" + "=" * 80)
                print(context.summary_text())
                print("=" * 80 + "\n")
            
            return 0
        
        result = research_stock(
            ticker=ticker,
            technical_metrics=technical_metrics,
            model=args.model,
        )
        
        log.info(
            "Research complete: decision=%s confidence=%.0f cost=$%.4f",
            result.decision,
            result.confidence,
            result.estimated_cost_usd,
        )
        
        if args.json:
            print(json.dumps(result.to_dict(), indent=2, default=str))
        else:
            print_human_readable(result)
        
        return 0
        
    except KeyboardInterrupt:
        log.info("Interrupted by user")
        return 130
    except Exception as e:
        log.error("Research failed: %s", e, exc_info=args.verbose)
        return 1


def print_human_readable(result: any) -> None:
    """Print research result in human-readable format."""
    print("\n" + "=" * 80)
    print(f"RESEARCH RESULT: {result.ticker}")
    print("=" * 80)
    print(f"\nDecision:    {result.decision}")
    print(f"Confidence:  {result.confidence:.0f}/100")
    print(f"Headline:    {result.headline}")
    
    if result.catalysts:
        print(f"\nCatalysts ({len(result.catalysts)}):")
        for i, catalyst in enumerate(result.catalysts, 1):
            print(f"  {i}. {catalyst}")
    
    if result.red_flags:
        print(f"\nRed Flags ({len(result.red_flags)}):")
        for i, flag in enumerate(result.red_flags, 1):
            print(f"  {i}. {flag}")
    
    print(f"\nSupporting Analysis:")
    print(f"  {result.supporting_text}")
    
    ctx = result.research_context
    print(f"\nData Sources:")
    print(f"  News Articles:    {len(ctx.news)}")
    print(f"  Risk Factors:     {len(ctx.risk_factors)}")
    print(f"  Material Events:  {len(ctx.material_events)}")
    print(f"  Filing Sections:  {len(ctx.filing_sections)}")
    
    print(f"\nAI Usage:")
    print(f"  Model:       {result.model_used}")
    print(f"  Tokens:      {result.tokens_used:,}")
    print(f"  Est. Cost:   ${result.estimated_cost_usd:.4f}")
    
    print("=" * 80 + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
