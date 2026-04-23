from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError


def _invalid_auth_hint() -> str:
    return (
        "HINT: Re-check the token in Slack → app → OAuth & Permissions → Bot User OAuth Token (after Install). "
        "In repo .env: SLACK_BOT_TOKEN=xoxb-... one line, no quotes, full token (~50+ chars). "
        "If you export SLACK_BOT_TOKEN in the shell, run `unset SLACK_BOT_TOKEN` or use this script’s "
        "defaults (it loads repo .env over shell for this command)."
    )


ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))
from signals_bot.notifiers.slack import normalize_slack_bot_token, normalize_slack_channel


def main() -> int:
    p = argparse.ArgumentParser(
        description="Verify SLACK_BOT_TOKEN (auth.test) and/or send a test message (loads .env from cwd)."
    )
    p.add_argument(
        "--auth-only",
        action="store_true",
        help="Only call auth.test (validates token). No channel or chat_postMessage.",
    )
    p.add_argument("--channel", default=None, help="Slack channel ID (overrides SLACK_CHANNEL env var).")
    p.add_argument("--text", default="signals-bot test message", help="Message text to send.")
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Print non-secret diagnostics (.env path, token character count).",
    )
    args = p.parse_args()

    env_path = ROOT_DIR / ".env"
    # Prefer repo .env over a stale SLACK_BOT_TOKEN exported in the shell (override=True).
    load_dotenv(env_path, override=True)

    token = normalize_slack_bot_token(os.getenv("SLACK_BOT_TOKEN"))
    if not token:
        print("ERROR: Missing SLACK_BOT_TOKEN (set it in .env)", file=sys.stderr)
        print(f"HINT: Expected {env_path}", file=sys.stderr)
        return 2
    if not token.startswith("xoxb-"):
        print("ERROR: SLACK_BOT_TOKEN must be a bot token starting with 'xoxb-'", file=sys.stderr)
        return 2

    if args.verbose:
        print(f".env: {env_path} (exists={env_path.is_file()})", file=sys.stderr)
        print(f"token: {len(token)} chars, starts with {token[:8]}…", file=sys.stderr)

    client = WebClient(token=token)

    if args.auth_only:
        try:
            r = client.auth_test()
        except SlackApiError as e:
            err = e.response.get("error") if e.response is not None else str(e)
            print(f"ERROR: auth.test failed: {err}", file=sys.stderr)
            if err == "invalid_auth":
                print(_invalid_auth_hint(), file=sys.stderr)
                if not args.verbose:
                    print("HINT: Run with -v to print token length (catch truncated copy/paste).", file=sys.stderr)
            return 1
        print("OK: token is valid.")
        print(f"  team: {r.get('team')} ({r.get('team_id')})")
        print(f"  bot user: {r.get('user')} ({r.get('user_id')})")
        print(f"  url: {r.get('url')}")
        return 0

    channel = normalize_slack_channel(args.channel) or normalize_slack_channel(os.getenv("SLACK_CHANNEL"))
    if not channel:
        print("ERROR: Missing channel (pass --channel or set SLACK_CHANNEL in .env)", file=sys.stderr)
        return 2

    try:
        client.chat_postMessage(channel=channel, text=args.text)
    except SlackApiError as e:
        err = e.response.get("error") if e.response is not None else str(e)
        print(f"ERROR: Slack API call failed: {err}", file=sys.stderr)
        if err == "invalid_auth":
            print(_invalid_auth_hint(), file=sys.stderr)
            if not args.verbose:
                print("HINT: Run with -v to print token length (catch truncated copy/paste).", file=sys.stderr)
        return 1

    print("OK: Slack message sent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

