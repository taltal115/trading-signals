from __future__ import annotations

import argparse
import os
import sys

from dotenv import load_dotenv
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError


def main() -> int:
    p = argparse.ArgumentParser(description="Send a test Slack message using SLACK_BOT_TOKEN from .env.")
    p.add_argument("--channel", default=None, help="Slack channel ID (overrides SLACK_CHANNEL env var).")
    p.add_argument("--text", default="signals-bot test message", help="Message text to send.")
    args = p.parse_args()

    load_dotenv(override=False)

    token = os.getenv("SLACK_BOT_TOKEN")
    if not token:
        print("ERROR: Missing SLACK_BOT_TOKEN (set it in .env)", file=sys.stderr)
        return 2
    if not token.startswith("xoxb-"):
        print("ERROR: SLACK_BOT_TOKEN must be a bot token starting with 'xoxb-'", file=sys.stderr)
        return 2

    channel = args.channel or os.getenv("SLACK_CHANNEL")
    if not channel:
        print("ERROR: Missing channel (pass --channel or set SLACK_CHANNEL in .env)", file=sys.stderr)
        return 2

    client = WebClient(token=token)
    try:
        client.chat_postMessage(channel=channel, text=args.text)
    except SlackApiError as e:
        err = e.response.get("error") if hasattr(e, "response") else str(e)
        print(f"ERROR: Slack API call failed: {err}", file=sys.stderr)
        return 1

    print("OK: Slack message sent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

