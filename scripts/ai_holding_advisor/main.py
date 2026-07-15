"""Holding advisor: LLM advice for open my_positions (HOLD/TIGHTEN/EXTEND/EXIT)."""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from google.cloud.firestore_v1.base_query import FieldFilter

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(REPO_ROOT))

from signals_bot.config import load_config
from signals_bot.storage.firestore import MY_POSITIONS_COLLECTION, get_firestore_client
from signals_bot.trading_calendar import xnys_sessions_between

from scripts.ai_stock_eval.context import finnhub_quote_and_news
from scripts.ai_stock_eval.firestore_write import write_holding_evaluation
from scripts.ai_stock_eval.llm import call_openai_json
from scripts.ai_stock_eval.prompts import get_holding_prompts


def _setup_logging() -> logging.Logger:
    log = logging.getLogger("ai_holding_advisor")
    if not log.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
        log.addHandler(h)
    log.setLevel(logging.INFO)
    return log


def _render(template: str, variables: dict[str, str]) -> str:
    out = template
    for k, v in variables.items():
        out = out.replace("{{" + k + "}}", v)
    return out


def _finnhub_social_summary(ticker: str) -> str:
    api_key = (os.getenv("FINNHUB_API_KEY") or "").strip()
    if not api_key:
        return "No Finnhub key; social sentiment unavailable."
    try:
        import finnhub

        client = finnhub.Client(api_key=api_key)
        # stock_social_sentiment(symbol, from, to) — API may vary by client version
        end = datetime.now(timezone.utc).date()
        start = end.fromordinal(end.toordinal() - 7)
        raw = None
        if hasattr(client, "stock_social_sentiment"):
            raw = client.stock_social_sentiment(
                ticker.strip().upper(),
                _from=start.isoformat(),
                to=end.isoformat(),
            )
        elif hasattr(client, "social_sentiment"):
            raw = client.social_sentiment(ticker.strip().upper())
        if not raw:
            return "No social sentiment data returned."
        if isinstance(raw, dict):
            reddit = raw.get("reddit") or []
            twitter = raw.get("twitter") or []
            parts = []
            if isinstance(reddit, list) and reddit:
                last = reddit[-1] if isinstance(reddit[-1], dict) else {}
                parts.append(
                    f"Reddit mention={last.get('mention', '?')} "
                    f"positive={last.get('positiveMention', '?')} "
                    f"negative={last.get('negativeMention', '?')} "
                    f"score={last.get('score', '?')}"
                )
            if isinstance(twitter, list) and twitter:
                last = twitter[-1] if isinstance(twitter[-1], dict) else {}
                parts.append(
                    f"Twitter mention={last.get('mention', '?')} "
                    f"positive={last.get('positiveMention', '?')} "
                    f"negative={last.get('negativeMention', '?')} "
                    f"score={last.get('score', '?')}"
                )
            return "; ".join(parts) if parts else str(raw)[:500]
        return str(raw)[:500]
    except Exception as e:  # noqa: BLE001
        return f"Social sentiment error: {e}"


def _normalize_advice(raw: dict[str, Any]) -> dict[str, Any]:
    advice = str(raw.get("advice") or "HOLD").upper()
    if advice not in ("HOLD", "TIGHTEN", "EXTEND", "EXIT"):
        advice = "HOLD"
    revised_hold = raw.get("revised_hold_days")
    revised_stop = raw.get("revised_stop")
    try:
        rh = int(revised_hold) if revised_hold is not None else None
    except (TypeError, ValueError):
        rh = None
    try:
        rs = float(revised_stop) if revised_stop is not None else None
    except (TypeError, ValueError):
        rs = None
    risk = str(raw.get("risk_level") or "medium").lower()
    if risk not in ("low", "medium", "high"):
        risk = "medium"
    return {
        "advice": advice,
        "headline": str(raw.get("headline") or "").strip() or f"Advice: {advice}",
        "why": str(raw.get("why") or "").strip(),
        "risk_level": risk,
        "revised_hold_days": rh,
        "revised_stop": rs,
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="AI holding advisor for open positions.")
    p.add_argument("--config", default="config.yaml")
    p.add_argument("--owner-uid", default="", help="Limit to one owner (optional)")
    p.add_argument("--ticker", default="", help="Limit to one ticker (optional)")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--stdout-json", action="store_true")
    args = p.parse_args(argv)

    load_dotenv(REPO_ROOT / ".env", override=False)
    log = _setup_logging()
    if not (os.getenv("OPENAI_API_KEY") or "").strip():
        log.warning("OPENAI_API_KEY unset — stub LLM responses")

    cfg_path = Path(args.config)
    if not cfg_path.is_absolute():
        cfg_path = REPO_ROOT / cfg_path
    cfg = load_config(cfg_path.resolve())
    ai_cfg = getattr(cfg, "ai", None)
    if ai_cfg is not None and not bool(getattr(ai_cfg, "enabled", True)):
        log.info("ai.enabled=false — skipping")
        return 0

    db = get_firestore_client()
    q = db.collection(MY_POSITIONS_COLLECTION).where(filter=FieldFilter("status", "==", "open"))
    owner = str(args.owner_uid).strip()
    if owner:
        q = q.where(filter=FieldFilter("owner_uid", "==", owner))
    docs = list(q.stream())
    ticker_filter = str(args.ticker).strip().upper()
    cap = int(getattr(ai_cfg, "max_holding_evals_per_run", 20) if ai_cfg else 20)
    model = str(getattr(ai_cfg, "model", "gpt-4.1") if ai_cfg else "gpt-4.1")
    pricing = getattr(ai_cfg, "pricing", None) if ai_cfg else None

    system_prompt, user_template = get_holding_prompts()
    market_tz = ZoneInfo(cfg.run.timezone)
    now = datetime.now(timezone.utc)
    evaluated = 0

    for snap in docs:
        if evaluated >= cap:
            break
        data = snap.to_dict() or {}
        ticker = str(data.get("ticker") or "").strip().upper()
        if not ticker:
            continue
        if ticker_filter and ticker != ticker_filter:
            continue

        entry = float(data.get("entry_price") or 0.0)
        stop = float(data.get("stop_price") or data.get("ai_revised_stop") or 0.0)
        target = float(data.get("target_price") or 0.0)
        plan_hold = int(data.get("ai_revised_hold_days") or data.get("hold_days_from_signal") or 0)
        quote, headlines = finnhub_quote_and_news(ticker)
        current = float(quote.price or 0.0)
        if current <= 0 and entry > 0:
            current = entry
        pnl_pct = ((current - entry) / entry * 100.0) if entry > 0 else 0.0
        created_s = data.get("created_at_utc")
        days_held = 0
        if isinstance(created_s, str):
            try:
                created_dt = datetime.fromisoformat(created_s.replace("Z", "+00:00"))
                days_held = xnys_sessions_between(created_dt, now, market_tz)
            except ValueError:
                pass

        hl_lines = "\n".join(f"- {h.title}" for h in headlines[:8]) or "No headlines available."
        social = _finnhub_social_summary(ticker)
        risk_notes = (
            f"Existing holding_advice={data.get('holding_advice')}; "
            f"last_alert={data.get('last_alert_kind')}"
        )
        user_msg = _render(
            user_template,
            {
                "ticker": ticker,
                "entry_price": f"{entry:.2f}",
                "current_price": f"{current:.2f}",
                "pnl_pct": f"{pnl_pct:+.2f}",
                "days_held": str(days_held),
                "plan_hold_days": str(plan_hold or "?"),
                "stop": f"{stop:.2f}",
                "target": f"{target:.2f}",
                "headlines": hl_lines,
                "social_summary": social,
                "risk_notes": risk_notes,
            },
        )

        raw, usage, _raw_text = call_openai_json(
            system=system_prompt,
            user=user_msg,
            model=model,
            pricing=pricing,
        )
        advice = _normalize_advice(raw if isinstance(raw, dict) else {})
        log.info(
            "Holding %s advice=%s tokens=%d | %s",
            ticker,
            advice["advice"],
            usage.total_tokens,
            advice["headline"],
        )
        if args.stdout_json:
            import json

            print(json.dumps({"ticker": ticker, "advice": advice, "usage": usage.__dict__}, default=str))
        if args.dry_run:
            evaluated += 1
            continue

        write_holding_evaluation(
            ticker=ticker,
            position_id=snap.id,
            owner_uid=str(data.get("owner_uid") or "") or None,
            advice=advice,
            usage=usage,
            signal_doc_id=str(data.get("signal_doc_id") or ""),
            detail={"raw": raw},
        )
        evaluated += 1

    log.info("Holding advisor complete evaluated=%s", evaluated)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
