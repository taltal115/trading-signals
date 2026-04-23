from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Iterable

from dotenv import load_dotenv
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

from signals_bot.strategy.breakout import Signal

def normalize_slack_bot_token(raw: str | None) -> str | None:
    """Strip common .env / copy-paste pollution so Slack accepts the token."""
    if raw is None:
        return None
    t = raw.strip().removeprefix("\ufeff")
    if len(t) >= 2 and t[0] == t[-1] and t[0] in "'\"":
        t = t[1:-1].strip()
    if t.lower().startswith("bearer "):
        t = t[7:].strip()
    return t or None


def normalize_slack_channel(raw: str | None) -> str | None:
    """Strip quotes / BOM from channel id or name."""
    if raw is None:
        return None
    c = raw.strip().removeprefix("\ufeff")
    if len(c) >= 2 and c[0] == c[-1] and c[0] in "'\"":
        c = c[1:-1].strip()
    return c or None


SECTOR_PALETTE = [
    "#2eb886",
    "#36a2eb",
    "#ff6384",
    "#ff9f40",
    "#9966ff",
    "#4bc0c0",
    "#c9cb3f",
    "#e74c3c",
    "#3498db",
    "#1abc9c",
    "#e67e22",
    "#8e44ad",
]


def sector_color(sector: str) -> str:
    if not sector:
        return "#808080"
    idx = hash(sector) % len(SECTOR_PALETTE)
    return SECTOR_PALETTE[idx]


def _fmt_money(x: float | None) -> str:
    if x is None:
        return "-"
    return f"${x:,.2f}"


def _fmt_pct(x: float | None) -> str:
    if x is None:
        return "-"
    return f"{x:,.2f}%"


def _pct_from_close(level: float | None, base: float | None) -> float | None:
    if level is None or base is None or base == 0:
        return None
    return ((level - base) / base) * 100.0


def _build_signal_attachment(s: Signal) -> dict | None:
    if s.action not in {"BUY", "SELL"}:
        return None

    m = s.metrics or {}
    close = s.close
    stop = s.suggested_stop
    target = s.suggested_target
    stop_pct = _pct_from_close(stop, close)
    target_pct = _pct_from_close(target, close)

    action_emoji = ":green_circle:" if s.action == "BUY" else ":red_circle:"
    header = f"{action_emoji} *{s.action}* `{s.ticker}` conf={int(s.confidence)} • Price: ${s.close:,.2f}"

    hold_days = int(s.max_hold_days) if s.max_hold_days is not None else None
    est_hold = m.get("estimated_hold_days")
    hold_str = f"{hold_days}d" if hold_days is not None else "-"
    if est_hold is not None:
        hold_str += f" (ATR est: {est_hold:.1f}d)"
    hold_line = f"• Hold: {hold_str}"

    sl_line = f"• SL: {_fmt_money(stop)} ({_fmt_pct(stop_pct)})"
    tp_line = f"• TP: {_fmt_money(target)} ({_fmt_pct(target_pct)})"

    sector = m.get("sector", "")
    industry = m.get("industry", "")
    sector_line = ""
    if sector:
        sector_line = f"• Sector: {sector}"
        if industry:
            sector_line += f" / {industry}"

    lines = [header, hold_line, sl_line, tp_line]
    if sector_line:
        lines.append(sector_line)
    body = "\n".join(lines)

    return {
        "color": sector_color(str(sector)),
        "blocks": [
            {"type": "section", "text": {"type": "mrkdwn", "text": body}},
        ],
    }


@dataclass(frozen=True)
class SlackNotifier:
    client: WebClient
    channel: str

    @staticmethod
    def from_env_and_config(*, channel: str) -> "SlackNotifier":
        load_dotenv(override=False)

        token = normalize_slack_bot_token(os.getenv("SLACK_BOT_TOKEN"))
        if not token:
            raise ValueError("Missing SLACK_BOT_TOKEN in environment/.env")
        if not token.startswith("xoxb-"):
            raise ValueError(
                "SLACK_BOT_TOKEN must be a bot token starting with 'xoxb-'. "
                "Your token type is not allowed for chat.postMessage."
            )

        env_channel = normalize_slack_channel(os.getenv("SLACK_CHANNEL"))
        resolved_channel = env_channel or normalize_slack_channel(channel)
        if not resolved_channel or resolved_channel == "YOUR_CHANNEL_ID":
            raise ValueError("Missing Slack channel (set slack.channel in YAML or SLACK_CHANNEL in .env)")

        return SlackNotifier(client=WebClient(token=token), channel=resolved_channel)

    def post_signals(
        self,
        *,
        run_name: str,
        asof_date: date,
        signals: Iterable[Signal],
        top_n: int,
        min_confidence: int,
    ) -> None:
        sigs = [s for s in signals if s.confidence >= min_confidence]
        sigs = sigs[:top_n]
        if not sigs:
            return

        actionable = [s for s in sigs if s.action == "BUY"]
        if not actionable:
            return

        attachments = []
        for s in actionable:
            att = _build_signal_attachment(s)
            if att:
                attachments.append(att)

        if not attachments:
            return

        now = datetime.now(timezone.utc)
        header = f":chart_with_upwards_trend: *Signal scan* — {now.strftime('%Y-%m-%d %H:%M')} UTC"

        try:
            self.client.chat_postMessage(
                channel=self.channel,
                text=header,
                attachments=attachments,
            )
        except SlackApiError as e:
            raise RuntimeError(f"Slack post failed: {e.response.get('error')}") from e

