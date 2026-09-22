#!/usr/bin/env python3
"""
Post Week 1 review notification to Slack.

Usage:
    SLACK_BOT_TOKEN=xoxb-... python scripts/notify_week1_review.py
"""

import os
import sys
from pathlib import Path

# Add src to path
ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from signals_bot.notifications.slack import post_message


def main():
    slack_token = os.getenv("SLACK_BOT_TOKEN")
    if not slack_token:
        print("Error: SLACK_BOT_TOKEN environment variable not set", file=sys.stderr)
        sys.exit(1)

    channel = os.getenv("SLACK_CHANNEL", "#trading-signals")
    
    message = """🔔 *Week 1 Signal Volume Expansion — Review Checkpoint*

📊 *Run cohort analysis*:
```
cd /workspace
source .venv/bin/activate
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py --since 2026-09-23
```

📋 *Review targets*:
• Technical BUYs: ≥25 (target: 5/day)
• `ai_gate=passed`: ≥5 (target: 1/day)
• All BUYs PF: ≥1.3

✅ If targets met → proceed to Week 2 fine-tuning
⚠️ If underperforming → diagnose discovery/scan/AI logs before advancing

📖 *Full details*:
• Week 1: `docs/research/2026-09/signal-volume-expansion-2026-09-22.md`
• Week 2 plan: `docs/research/2026-09/week2-action-plan.md`
"""

    try:
        result = post_message(
            token=slack_token,
            channel=channel,
            message=message,
        )
        print(f"✅ Posted to {channel}: {result}")
    except Exception as e:
        print(f"❌ Failed to post: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
