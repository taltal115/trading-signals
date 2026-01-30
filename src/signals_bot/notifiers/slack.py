from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date
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
        if not sigs:
            text = f"*signals-bot* `{run_name}` as-of *{asof_date.isoformat()}*\\nNo signals."
        else:
            actionable = [s for s in sigs if s.action in {"BUY", "SELL"}]
            if not actionable:
                text = f"*signals-bot* `{run_name}` as-of *{asof_date.isoformat()}*\\nNo BUY/SELL signals."
            else:
                text = _fmt_action_table(actionable)
                if not text:
                    text = f"*signals-bot* `{run_name}` as-of *{asof_date.isoformat()}*\\nNo BUY/SELL signals."

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
    rows = []
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

        rows.append(
            (
                s.action,
                s.ticker,
                int(s.confidence),
                int(s.max_hold_days),
                stop,
                stop_pct,
                target,
                target_pct,
            )
        )

    if not rows:
        return ""

    action_w = max(len("ACTION"), max(len(r[0]) for r in rows))
    ticker_w = max(len("TICKER"), max(len(str(r[1])) for r in rows))
    conf_w = max(len("CONF"), max(len(str(r[2])) for r in rows))
    hold_w = max(len("HOLD"), max(len(str(r[3])) for r in rows))
    sl_w = max(len("SL"), max(len(_fmt_money(r[4])) for r in rows))
    slp_w = max(len("SL%"), max(len(_fmt_pct(r[5])) for r in rows))
    tp_w = max(len("TP"), max(len(_fmt_money(r[6])) for r in rows))
    tpp_w = max(len("TP%"), max(len(_fmt_pct(r[7])) for r in rows))

    header = (
        f"{'ACTION':<{action_w}}  {'TICKER':<{ticker_w}}  {'CONF':>{conf_w}}  "
        f"{'HOLD':>{hold_w}}  {'SL':>{sl_w}}  {'SL%':>{slp_w}}  {'TP':>{tp_w}}  {'TP%':>{tpp_w}}"
    )
    sep = (
        f"{'-' * action_w}  {'-' * ticker_w}  {'-' * conf_w}  "
        f"{'-' * hold_w}  {'-' * sl_w}  {'-' * slp_w}  {'-' * tp_w}  {'-' * tpp_w}"
    )
    body = [
        (
            f"{a:<{action_w}}  {t:<{ticker_w}}  {c:>{conf_w}}  {h:>{hold_w}}  "
            f"{_fmt_money(sl):>{sl_w}}  {_fmt_pct(slp):>{slp_w}}  "
            f"{_fmt_money(tp):>{tp_w}}  {_fmt_pct(tpp):>{tpp_w}}"
        )
        for a, t, c, h, sl, slp, tp, tpp in rows
    ]
    table = "\n".join([header, sep, *body])
    return f"```{table}```"

