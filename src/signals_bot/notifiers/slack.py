from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Iterable

from dotenv import load_dotenv
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

from signals_bot.strategy.breakout import Signal


@dataclass(frozen=True)
class SlackNotifier:
    client: WebClient
    channel: str

    @staticmethod
    def from_env_and_config(*, channel: str) -> "SlackNotifier":
        # Loads local .env if present (we keep .env out of git).
        load_dotenv(override=False)

        token = os.getenv("SLACK_BOT_TOKEN")
        if not token:
            raise ValueError("Missing SLACK_BOT_TOKEN in environment/.env")
        if not token.startswith("xoxb-"):
            raise ValueError(
                "SLACK_BOT_TOKEN must be a bot token starting with 'xoxb-'. "
                "Your token type is not allowed for chat.postMessage."
            )

        env_channel = os.getenv("SLACK_CHANNEL")
        resolved_channel = env_channel or channel
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
        # If there are no signals (or no actionable BUY signals), skip Slack entirely.
        if not sigs:
            return

        actionable = [s for s in sigs if s.action == "BUY"]
        if not actionable:
            return

        text = _fmt_action_table(actionable)
        if not text:
            return

        try:
            self.client.chat_postMessage(channel=self.channel, text=text)
        except SlackApiError as e:
            raise RuntimeError(f"Slack post failed: {e.response.get('error')}") from e


def _fmt_line(s: Signal) -> str:
    m = s.metrics or {}
    ret5 = m.get("ret_5d_pct")
    volr = m.get("vol_ratio")
    brk = m.get("breakout_dist_pct")
    atr = m.get("atr_pct")

    def pct(x: float | None) -> str:
        return "-" if x is None else f"{x:.1f}%"

    def num(x: float | None) -> str:
        return "-" if x is None else f"{x:.2f}"

    parts = [
        f"- *{s.action}* `{s.ticker}` conf={s.confidence} close=${s.close:.2f}",
        f"ret5={pct(ret5)} volR={num(volr)} brkDist={pct(brk)} atr={pct(atr)}",
        f"_{s.notes}_",
    ]
    if s.action == "BUY":
        entry = s.suggested_entry or s.close
        stop = "-" if s.suggested_stop is None else f"${s.suggested_stop:.2f}"
        target = "-" if s.suggested_target is None else f"${s.suggested_target:.2f}"
        parts.append(f"entry=${entry:.2f} stop={stop} target={target}")
    return " | ".join(parts)


def _fmt_money(x: float | None) -> str:
    if x is None:
        return "-"
    return f"${x:,.2f}"


def _fmt_pct(x: float | None) -> str:
    if x is None:
        return "-"
    return f"{x:,.2f}%"


def _fmt_action_table(signals: Iterable[Signal]) -> str:
    blocks = []
    for s in signals:
        if s.action not in {"BUY", "SELL"}:
            continue

        close = s.close
        stop = s.suggested_stop
        target = s.suggested_target

        def pct_from_close(level: float | None, base: float | None) -> float | None:
            if level is None or base is None or base == 0:
                return None
            return ((level - base) / base) * 100.0

        stop_pct = pct_from_close(stop, close)
        target_pct = pct_from_close(target, close)

        action_emoji = ":green_circle:" if s.action == "BUY" else ":red_circle:"
        signal_header = f"{action_emoji} *{s.action}* `{s.ticker}` conf={int(s.confidence)} • Price: ${s.close:,.2f}"
        hold_days = int(s.max_hold_days) if s.max_hold_days is not None else None
        hold_line = f"• Hold: {hold_days}d" if hold_days is not None else "• Hold: -"
        sl_line = f"• SL: {_fmt_money(stop)} ({_fmt_pct(stop_pct)})"
        tp_line = f"• TP: {_fmt_money(target)} ({_fmt_pct(target_pct)})"

        block = "\n".join([signal_header, hold_line, sl_line, tp_line])
        blocks.append(block)

    if not blocks:
        return ""

    now = datetime.now(timezone.utc)
    header = f"📅 {now.strftime('%Y-%m-%d %H:%M:%S')} UTC"
    return "\n".join([header, ""] + blocks)

