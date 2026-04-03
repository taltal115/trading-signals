from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from google.cloud import firestore
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from signals_bot.config import AppConfig, load_config
from signals_bot.notifiers.slack import SECTOR_PALETTE, sector_color
from signals_bot.providers.stooq import StooqProvider
from signals_bot.providers.yahoo import YahooProvider
from signals_bot.storage.firestore import get_firestore_client

NEAR_THRESHOLD_PCT = 0.75


@dataclass(frozen=True)
class Alert:
    kind: str  # STOP_HIT, STOP_NEAR, TARGET_HIT, TARGET_NEAR, TIME_WARN, HOLD_REVIEW, POSITION_WAIT
    confidence: int
    message: str


def _build_firestore_client() -> firestore.Client:
    return get_firestore_client()


def _atr14_from_hist(df: pd.DataFrame) -> float | None:
    if df is None or len(df) < 15:
        return None
    high = df["high"]
    low = df["low"]
    close = df["close"]
    prev_close = close.shift(1)
    tr = pd.concat(
        [(high - low).abs(), (high - prev_close).abs(), (low - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    atr = tr.rolling(14).mean()
    val = atr.iloc[-1]
    if pd.isna(val):
        return None
    return float(val)


def _last_close_and_atr(
    *,
    ticker: str,
    providers: dict[str, Any],
    provider_order: list[str],
    lookback_days: int,
) -> tuple[float | None, float | None]:
    for name in provider_order:
        prov = providers.get(name)
        if not prov:
            continue
        try:
            hist = prov.get_history(ticker, lookback_days=lookback_days)
            if hist is None or hist.empty:
                continue
            close_val = float(hist["close"].iloc[-1])
            atr_val = _atr14_from_hist(hist)
            return close_val, atr_val
        except Exception:
            continue
    return None, None


def _eval_position(
    *,
    data: dict[str, Any],
    last_close: float | None,
    atr14: float | None,
    today: date,
) -> Alert:
    ticker = str(data.get("ticker", ""))
    if last_close is None:
        return Alert(
            "POSITION_WAIT",
            40,
            f"{ticker} | reason: no daily close from configured providers yet — "
            "cannot evaluate stop, target, or hold window until a price is available",
        )

    entry = data.get("entry_price")
    stop = data.get("stop_price")
    target = data.get("target_price")
    hold_days = data.get("hold_days_from_signal")
    created_s = data.get("created_at_utc")

    age_days = None
    if isinstance(created_s, str):
        try:
            created_dt = datetime.fromisoformat(created_s.replace("Z", "+00:00"))
            age_days = (datetime.now(timezone.utc).date() - created_dt.date()).days
        except ValueError:
            age_days = None

    entry_f = float(entry) if isinstance(entry, (int, float)) else None

    if isinstance(stop, (int, float)) and last_close <= float(stop):
        return Alert(
            "STOP_HIT",
            88,
            f"{ticker} | reason: last close at or below stop — defensive / risk stop level touched | "
            f"close={last_close:.2f} stop={float(stop):.2f}",
        )

    if isinstance(target, (int, float)) and last_close >= float(target):
        return Alert(
            "TARGET_HIT",
            80,
            f"{ticker} | reason: last close at or above take-profit target | "
            f"close={last_close:.2f} target={float(target):.2f}",
        )

    if isinstance(hold_days, int) and hold_days > 0 and age_days is not None and age_days >= hold_days:
        return Alert(
            "TIME_WARN",
            72,
            f"{ticker} | reason: max hold from signal reached (time-based exit cue) — "
            f"review plan vs age={age_days}d hold_days={hold_days} | close={last_close:.2f}",
        )

    if isinstance(hold_days, int) and hold_days > 0 and age_days is not None and age_days == hold_days - 1:
        atr_ctx = ""
        if atr14 and entry_f and isinstance(target, (int, float)):
            remaining_dist = float(target) - last_close
            if atr14 > 0:
                est_days_left = remaining_dist / atr14
                atr_ctx = f" | ATR suggests ~{est_days_left:.1f}d more to target"
        return Alert(
            "HOLD_REVIEW",
            60,
            f"{ticker} | reason: 1 day before max hold expires — "
            f"age={age_days}d of {hold_days}d, close={last_close:.2f}{atr_ctx}",
        )

    if entry_f and isinstance(stop, (int, float)) and float(stop) < entry_f:
        dist_pct = ((last_close - float(stop)) / entry_f) * 100.0
        if 0 < dist_pct <= NEAR_THRESHOLD_PCT:
            return Alert(
                "STOP_NEAR",
                70,
                f"{ticker} | reason: within {NEAR_THRESHOLD_PCT:.1f}% of entry→stop cushion (above stop but tight) — "
                f"elevated stop risk | spot={last_close:.2f}",
            )

    if entry_f and isinstance(target, (int, float)) and float(target) > entry_f:
        gap = float(target) - last_close
        room_pct = (gap / float(target)) * 100.0 if float(target) else 100.0
        if 0 < room_pct <= NEAR_THRESHOLD_PCT:
            return Alert(
                "TARGET_NEAR",
                65,
                f"{ticker} | reason: within {NEAR_THRESHOLD_PCT:.1f}% of target (profit zone) — "
                f"consider partial exit or tightening risk | spot={last_close:.2f}",
            )

    atr_note = ""
    if atr14:
        atr_note = f" | atr14={atr14:.2f}"
    return Alert(
        "POSITION_WAIT",
        55,
        f"{ticker} | reason: inside planned bracket — no stop breach, target hit, hold overrun, or near-threshold flag | "
        f"spot={last_close:.2f}{atr_note}",
    )


def _compute_pnl_pct(entry: Any, spot: float | None) -> float | None:
    if spot is None:
        return None
    entry_f = float(entry) if isinstance(entry, (int, float)) else None
    if entry_f is None or entry_f == 0:
        return None
    return ((spot - entry_f) / entry_f) * 100.0


def _compute_days_held(created_s: Any) -> int | None:
    if not isinstance(created_s, str):
        return None
    try:
        created_dt = datetime.fromisoformat(created_s.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc).date() - created_dt.date()).days
    except ValueError:
        return None


def _load_reason_trail(ref: firestore.DocumentReference) -> list[str]:
    try:
        checks = ref.collection("checks").order_by("ts_utc").stream()
        trail = []
        for doc in checks:
            c = doc.to_dict() or {}
            ts_short = str(c.get("ts_utc", ""))[:10]
            tag = c.get("tag", "")
            summary = c.get("alert_summary", "")
            pnl = c.get("pnl_pct")
            pnl_str = f" P/L={pnl:+.1f}%" if isinstance(pnl, (int, float)) else ""
            spot = c.get("last_spot")
            spot_str = f" spot=${spot:.2f}" if isinstance(spot, (int, float)) else ""
            short_reason = summary.split(" | reason: ")[-1].split(" | ")[0] if " | reason: " in summary else summary
            trail.append(f"{ts_short} {tag}: {short_reason}{spot_str}{pnl_str}")
        return trail
    except Exception as exc:
        print(f"  WARN: failed to load reason trail: {exc}")
        return []


def _build_exit_attachment(
    *,
    ticker: str,
    alert: Alert,
    data: dict[str, Any],
    last_close: float | None,
    reason_trail: list[str],
) -> dict:
    sector = data.get("sector", "")
    entry_f = float(data["entry_price"]) if isinstance(data.get("entry_price"), (int, float)) else None
    pnl_pct = _compute_pnl_pct(data.get("entry_price"), last_close)
    hold_days = data.get("hold_days_from_signal")
    days_held = _compute_days_held(data.get("created_at_utc"))

    tag = "SELL" if alert.kind in ("STOP_HIT", "TARGET_HIT", "TIME_WARN") else "REVIEW"
    action_emoji = ":red_circle:" if tag == "SELL" else ":warning:"

    lines = [f"{action_emoji} *{tag}* `{ticker}` — {alert.kind.replace('_', ' ').lower()}"]

    if entry_f is not None and last_close is not None:
        pnl_str = f"{pnl_pct:+.1f}%" if pnl_pct is not None else ""
        lines.append(f"Entry: ${entry_f:.2f} → Spot: ${last_close:.2f} ({pnl_str})")

    if days_held is not None and hold_days is not None:
        lines.append(f"Hold: {days_held}/{hold_days}d")
    elif days_held is not None:
        lines.append(f"Held: {days_held}d")

    if reason_trail:
        lines.append("")
        lines.append("*Decision trail:*")
        for entry in reason_trail[-8:]:
            lines.append(f"  {entry}")

    body = "\n".join(lines)
    color = sector_color(str(sector)) if sector else "#e74c3c"

    return {
        "color": color,
        "blocks": [
            {"type": "section", "text": {"type": "mrkdwn", "text": body}},
        ],
    }


def _build_wait_attachment(
    *,
    ticker: str,
    alert: Alert,
    data: dict[str, Any],
    last_close: float | None,
) -> dict:
    sector = data.get("sector", "")
    lines = [f":large_blue_circle: *WAIT* `{ticker}` — {alert.kind.replace('_', ' ').lower()}"]
    entry_f = float(data["entry_price"]) if isinstance(data.get("entry_price"), (int, float)) else None
    pnl_pct = _compute_pnl_pct(data.get("entry_price"), last_close)
    if entry_f is not None and last_close is not None:
        pnl_str = f"{pnl_pct:+.1f}%" if pnl_pct is not None else ""
        lines.append(f"Entry: ${entry_f:.2f} → Spot: ${last_close:.2f} ({pnl_str})")
    body = "\n".join(lines)
    return {
        "color": sector_color(str(sector)) if sector else "#36a2eb",
        "blocks": [
            {"type": "section", "text": {"type": "mrkdwn", "text": body}},
        ],
    }


def _slack_post_blockkit(*, text: str, attachments: list[dict]) -> None:
    load_dotenv(override=False)
    token = os.getenv("SLACK_BOT_TOKEN")
    channel = os.getenv("SLACK_CHANNEL")
    if not token or not channel:
        print("WARN: SLACK_BOT_TOKEN or SLACK_CHANNEL missing; skip Slack.")
        return
    if not token.startswith("xoxb-"):
        print("WARN: invalid Slack bot token; skip Slack.")
        return
    client = WebClient(token=token)
    try:
        client.chat_postMessage(channel=channel, text=text, attachments=attachments)
    except SlackApiError as e:
        err = e.response.get("error") if e.response else str(e)
        print(f"WARN: Slack failed: {err}")


EXIT_KINDS = {"STOP_HIT", "TARGET_HIT", "TIME_WARN"}
NOTIFY_KINDS = EXIT_KINDS | {"STOP_NEAR", "TARGET_NEAR", "HOLD_REVIEW"}


def main() -> int:
    p = argparse.ArgumentParser(description="Monitor open manual positions; log + optional Slack (signal-only).")
    p.add_argument("--config", default="config.yaml", help="Path to YAML (provider + lookback).")
    p.add_argument(
        "--owner-uid",
        default=os.getenv("MONITOR_OWNER_UID", ""),
        help="Only positions with this Firebase Auth uid (default: env MONITOR_OWNER_UID or all open).",
    )
    p.add_argument("--dry-run", action="store_true", help="Do not write Firestore dedupe fields or Slack.")
    p.add_argument("--no-slack", action="store_true", help="Never post Slack.")
    args = p.parse_args()

    load_dotenv(override=False)
    cfg_path = Path(args.config).expanduser().resolve()
    cfg: AppConfig = load_config(cfg_path)

    db = _build_firestore_client()
    providers = {
        "yahoo": YahooProvider(
            timeout_sec=cfg.data.request_timeout_sec,
            ssl_verify=cfg.data.ssl_verify,
            ca_bundle_path=cfg.resolve_path(cfg.data.ca_bundle_path).as_posix() if cfg.data.ca_bundle_path else None,
        ),
        "stooq": StooqProvider(
            timeout_sec=cfg.data.request_timeout_sec,
            ssl_verify=cfg.data.ssl_verify,
            ca_bundle_path=cfg.resolve_path(cfg.data.ca_bundle_path).as_posix() if cfg.data.ca_bundle_path else None,
        ),
    }
    order = [x for x in cfg.data.provider_order if x in providers] or ["yahoo", "stooq"]
    today = datetime.now(cfg.tz()).date()

    q = db.collection("my_positions").where("status", "==", "open")
    owner_uid = (args.owner_uid or "").strip()
    if owner_uid:
        q = q.where("owner_uid", "==", owner_uid)

    docs = list(q.stream())
    print(f"monitor_open_positions: {len(docs)} open position(s)")

    exit_attachments: list[dict] = []
    notify_attachments: list[dict] = []

    for snap in docs:
        data = snap.to_dict() or {}
        ticker = str(data.get("ticker", "")).strip().upper()
        if not ticker:
            continue

        last_close, atr14 = _last_close_and_atr(
            ticker=ticker,
            providers=providers,
            provider_order=order,
            lookback_days=min(cfg.data.lookback_days, 60),
        )

        alert = _eval_position(data=data, last_close=last_close, atr14=atr14, today=today)
        prev_kind = data.get("last_alert_kind")
        ts = datetime.now(timezone.utc).isoformat()

        tag = "SELL" if alert.kind in EXIT_KINDS else "WAIT"
        log_line = f"[{tag}] conf={alert.confidence} :: {alert.message}"
        print(log_line)

        pnl_pct = _compute_pnl_pct(data.get("entry_price"), last_close)
        days_held = _compute_days_held(data.get("created_at_utc"))

        if not args.dry_run:
            ref = db.collection("my_positions").document(snap.id)
            ref.set(
                {
                    "updated_at_utc": ts,
                    "last_alert_kind": alert.kind,
                    "last_alert_summary": alert.message,
                    "last_alert_ts_utc": ts,
                    "last_spot": last_close,
                },
                merge=True,
            )
            print(f"  updated my_positions/{snap.id} fields")

            pos_owner = data.get("owner_uid") or owner_uid or None
            check_data: dict[str, Any] = {
                "ts_utc": ts,
                "alert_kind": alert.kind,
                "alert_summary": alert.message,
                "confidence": alert.confidence,
                "last_spot": last_close,
                "tag": tag,
                "ticker": ticker,
                "owner_uid": pos_owner,
                "pnl_pct": round(pnl_pct, 2) if pnl_pct is not None else None,
                "days_held": days_held,
            }
            if atr14 is not None:
                check_data["atr14"] = round(atr14, 4)
            try:
                _, check_ref = ref.collection("checks").add(check_data)
                print(f"  wrote check → my_positions/{snap.id}/checks/{check_ref.id}  owner_uid={pos_owner}")
            except Exception as exc:
                print(f"  ERROR writing check for {snap.id}: {exc}")

            should_notify = prev_kind != alert.kind and alert.kind in NOTIFY_KINDS
            if should_notify and not args.no_slack:
                if alert.kind in EXIT_KINDS:
                    trail = _load_reason_trail(ref)
                    att = _build_exit_attachment(
                        ticker=ticker,
                        alert=alert,
                        data=data,
                        last_close=last_close,
                        reason_trail=trail,
                    )
                    exit_attachments.append(att)
                else:
                    att = _build_wait_attachment(
                        ticker=ticker,
                        alert=alert,
                        data=data,
                        last_close=last_close,
                    )
                    notify_attachments.append(att)

    all_attachments = exit_attachments + notify_attachments
    if all_attachments and not args.no_slack and not args.dry_run:
        header = ":eyes: *Position monitor* (signal-only, not execution)"
        _slack_post_blockkit(text=header, attachments=all_attachments)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
