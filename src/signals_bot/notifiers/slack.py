from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Iterable

from dotenv import load_dotenv
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

from signals_bot.strategy.breakout import Signal

log = logging.getLogger(__name__)


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


def _looks_like_slack_conversation_id(channel: str) -> bool:
    """True if value looks like a channel id (public C… or private/shared G…) not a bare name."""
    s = channel.strip().upper()
    if len(s) < 9:
        return False
    # Slack IDs are alphanumeric starting with C, G (groups), occasionally other prefices.
    if s[0] not in ("C", "G"):
        return False
    tail = s[1:]
    return bool(re.fullmatch(r"[A-Z0-9]+", tail))


def try_conversations_join(client: WebClient, channel_id: str) -> None:
    """Join a public/shared channel before posting when the bot is not yet a member."""
    try:
        client.conversations_join(channel=channel_id)
        log.debug("Slack conversations.join ok channel=%s", channel_id)
    except SlackApiError as e:
        err = e.response.get("error") if e.response else ""
        # Common benign cases when Slack returns an error-shaped response for redundant join attempts.
        if err in ("already_in_channel",):
            return
        # Some workspaces restrict join — still attempt chat.postMessage.
        log.debug("Slack conversations.join skipped channel=%s error=%s", channel_id, err)


def resolve_slack_post_channel(client: WebClient, configured: str) -> str:
    """
    Return a channel value suitable for chat.postMessage.

    - Conversations IDs (starting with C or G…) are joined if needed then returned verbatim.
    - Names with or without # are mapped to IDs via conversations.list when possible
      (requires ``conversations:read`` — add it under Slack app OAuth scopes if resolution fails).

    Fallback: normalized original string (#name or bare name).
    """

    raw = normalize_slack_channel(configured)
    if not raw or raw == "YOUR_CHANNEL_ID":
        raise ValueError("Missing Slack channel (set slack.channel in YAML or SLACK_CHANNEL in .env)")

    if _looks_like_slack_conversation_id(raw):
        cid = raw.strip()
        try_conversations_join(client, cid)
        return cid

    name = raw.lstrip("#").strip().lower()
    if not name:
        raise ValueError("Invalid Slack channel name")

    cid = _find_public_or_private_channel_id_by_name(client, name)
    if cid:
        log.info(
            "Slack: resolved channel name %s to conversation id %s",
            repr(configured.strip()),
            cid,
        )
        try_conversations_join(client, cid)
        return cid

    log.warning(
        "Slack: channel name %r was not matched via conversations.list. "
        "Invite the bot to the channel (/invite …), add Bot scope **channels:read** "
        "(or **conversations:read**) and reinstall the app so names resolve, "
        "or set SLACK_CHANNEL to the channel ID from Slack "
        "(channel header → ⋮ → Copy channel ID, or archives URL …/archives/C…). "
        "Retrying post with configured value as-is.",
        configured.strip(),
    )
    return raw


def _find_public_or_private_channel_id_by_name(client: WebClient, name_lc: str) -> str | None:
    desired = name_lc.strip().lower()
    cursor: str | None = None
    pages = 0
    try:
        while pages < 40:
            kwargs: dict = {
                "types": "public_channel,private_channel",
                "exclude_archived": True,
                "limit": 500,
            }
            if cursor:
                kwargs["cursor"] = cursor
            resp = client.conversations_list(**kwargs)
            if not resp.get("ok"):
                log.warning("Slack conversations.list ok=false error=%s", resp.get("error"))
                return None
            for ch in resp.get("channels") or []:
                if isinstance(ch, dict) and (ch.get("name") or "").lower() == desired:
                    cid = ch.get("id")
                    return str(cid).strip() if cid else None
            meta = resp.get("response_metadata") or {}
            nxt = (meta.get("next_cursor") or "").strip()
            if not nxt:
                break
            cursor = nxt
            pages += 1
    except SlackApiError as e:
        err = e.response.get("error") if e.response else str(e)
        log.warning(
            "Slack conversations.list failed (%s). Add Bot scope channels:read (or conversations:read).",
            err,
        )
        return None
    return None


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


def _signal_mrkdown_section(s: Signal) -> str | None:
    """One BUY/SELL card as mrkdwn (for Block Kit section blocks)."""
    if s.action not in {"BUY", "SELL"}:
        return None

    m = s.metrics or {}
    close = s.close
    stop = s.suggested_stop
    target = s.suggested_target
    stop_pct = _pct_from_close(stop, close)
    target_pct = _pct_from_close(target, close)

    action_emoji = ":green_circle:" if s.action == "BUY" else ":red_circle:"
    header = f"{action_emoji} *{s.action}* `{s.ticker}` conf={int(s.confidence)} • Price: ${close:,.2f}"

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
    return "\n".join(lines)


@dataclass
class SlackNotifier:
    client: WebClient
    channel: str
    _post_channel_cache: str | None = field(default=None, repr=False)

    def _effective_post_channel(self) -> str:
        if self._post_channel_cache is not None:
            return self._post_channel_cache
        self._post_channel_cache = resolve_slack_post_channel(self.client, self.channel)
        return self._post_channel_cache

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

        # Top-level Block Kit only. Legacy ``attachments`` with nested ``blocks`` triggers
        # ``invalid_attachments`` / validation errors on many workspaces (see slackapi SDK #1247).
        now = datetime.now(timezone.utc)
        header = f":chart_with_upwards_trend: *Signal scan* — {now.strftime('%Y-%m-%d %H:%M')} UTC"
        blocks: list[dict] = [{"type": "section", "text": {"type": "mrkdwn", "text": header}}]
        for s in actionable:
            body = _signal_mrkdown_section(s)
            if body:
                blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": body}})

        if len(blocks) < 2:
            return

        post_ch = self._effective_post_channel()
        try:
            self.client.chat_postMessage(
                channel=post_ch,
                text=header,
                blocks=blocks,
            )
            log.info(
                "Slack post ok channel=%s BUY_sections=%d (min_confidence filter already applied)",
                post_ch,
                len(blocks) - 1,
            )
        except SlackApiError as e:
            err = e.response.get("error") if e.response else None
            log.error("Slack API error: %s full=%s", err, e.response)
            hint = ""
            if err == "channel_not_found":
                hint = (
                    " — Invite @YourBot into the channel (/invite …), set SLACK_CHANNEL to the Channel ID "
                    "(C…) from Slack, and grant the app Bot scopes: channels:read (list names), channels:join "
                    "(join public channels), then reinstall the workspace app."
                )
            raise RuntimeError(f"Slack post failed: {err}{hint}") from e

