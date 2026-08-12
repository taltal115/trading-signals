#!/usr/bin/env python3
"""Run profit-hold cohort research for the dashboard UI / GHA and persist to Firestore.

Usage:
  PYTHONPATH=./src:. python scripts/run_ui_profit_hold_research.py \\
    --since 2026-08-04 --actionable-only --notify-slack

  # Due-check (scheduled): only run full cohort if next_research.due_date <= today
  PYTHONPATH=./src:. python scripts/run_ui_profit_hold_research.py --due-check --notify-slack
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from signals_bot.config import load_config

from scripts.research_coa import (
    build_course_of_action,
    estimate_next_research,
    maybe_llm_narrative,
)
from scripts.research_profit_hold_cohort import run_cohort
from scripts.research_runs_store import (
    get_research_run,
    latest_succeeded_run,
    make_run_id,
    upsert_research_run,
)


def _setup_logging() -> logging.Logger:
    log = logging.getLogger("ui_profit_hold_research")
    if not log.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
        log.addHandler(h)
    log.setLevel(logging.INFO)
    return log


def _truthy(raw: str | None) -> bool:
    return str(raw or "").strip().lower() in ("1", "true", "yes", "on")


def _notify_slack(text: str, log: logging.Logger, *, channel_cfg: str) -> None:
    try:
        from signals_bot.notifiers.slack import SlackNotifier

        notifier = SlackNotifier.from_env_and_config(channel=channel_cfg)
        ch = notifier._effective_post_channel()
        notifier.client.chat_postMessage(channel=ch, text=text)
        log.info("Slack notify ok")
    except Exception as e:  # noqa: BLE001
        log.warning("Slack notify skipped/failed: %s", e)


def _run_research(
    *,
    log: logging.Logger,
    run_id: str,
    since: date,
    until: date | None,
    actionable_only: bool,
    include_immature: bool,
    limit_runs: int,
    config_path: Path,
    trigger: dict[str, Any],
    notify_slack: bool,
    write_local: bool,
) -> int:
    now = datetime.now(timezone.utc)
    created = now.isoformat()
    upsert_research_run(
        run_id,
        {
            "status": "running",
            "created_at_utc": created,
            "started_at_utc": created,
            "params": {
                "since": since.isoformat(),
                "until": until.isoformat() if until else None,
                "actionable_only": actionable_only,
                "include_immature": include_immature,
                "limit_runs": limit_runs,
            },
            "trigger": trigger,
        },
    )
    try:
        cfg = load_config(config_path)
        default_hold = int(cfg.strategy.max_hold_days)
        summary, rows = run_cohort(
            config_path=config_path,
            since=since,
            until=until,
            limit_runs=limit_runs,
            include_immature=include_immature,
            actionable_only=actionable_only,
        )
        coa = build_course_of_action(
            summary, since=since.isoformat(), actionable_only=actionable_only
        )
        narrative = maybe_llm_narrative(coa, summary)
        if narrative:
            coa["llm_narrative"] = narrative
        next_research = estimate_next_research(
            since=since,
            min_mature_passed_target=5,
            default_hold_days=default_hold,
        )
        coa["next_research"] = next_research
        finished = datetime.now(timezone.utc).isoformat()
        payload = {
            "status": "succeeded",
            "created_at_utc": created,
            "started_at_utc": created,
            "finished_at_utc": finished,
            "researched_at_utc": finished,
            "params": {
                "since": since.isoformat(),
                "until": until.isoformat() if until else None,
                "actionable_only": actionable_only,
                "include_immature": include_immature,
                "limit_runs": limit_runs,
            },
            "trigger": trigger,
            "summary": summary,
            "course_of_action": coa,
            "next_research": next_research,
            "n_detail_rows": len(rows),
        }
        upsert_research_run(run_id, payload)
        log.info(
            "Research run %s succeeded mature=%s loaded=%s",
            run_id,
            summary.get("n_mature_hold"),
            summary.get("n_unique_buys_loaded"),
        )

        if write_local:
            month = since.isoformat()[:7]
            out_dir = ROOT / "docs" / "research" / month
            out_dir.mkdir(parents=True, exist_ok=True)
            tag = "actionable" if actionable_only else "all"
            (out_dir / f"ui_research_{run_id}_{tag}_summary.json").write_text(
                json.dumps(payload, indent=2, default=str)
            )

        if notify_slack:
            overall = summary.get("overall_at_hold") or {}
            slack_cfg = getattr(cfg, "slack", None)
            channel = str(getattr(slack_cfg, "channel", "#trading-signals") if slack_cfg else "#trading-signals")
            _notify_slack(
                (
                    f":microscope: *Profit-hold research* `{run_id}`\n"
                    f"since={since.isoformat()} actionable_only={actionable_only}\n"
                    f"mature n={overall.get('n')} win%={overall.get('win_rate_pct')} "
                    f"avg={overall.get('avg_ret_pct')} PF={overall.get('profit_factor')}\n"
                    f"*Verdict:* {coa.get('verdict')}\n"
                    f"Next research due: {next_research.get('due_date')} — {next_research.get('reason')}"
                ),
                log,
                channel_cfg=channel,
            )
        return 0
    except Exception as e:  # noqa: BLE001
        log.exception("Research run failed: %s", e)
        upsert_research_run(
            run_id,
            {
                "status": "failed",
                "finished_at_utc": datetime.now(timezone.utc).isoformat(),
                "error": str(e)[:800],
                "trigger": trigger,
            },
        )
        return 1


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", default="config.yaml")
    p.add_argument("--since", default="2026-08-04")
    p.add_argument("--until", default="")
    p.add_argument("--limit-runs", type=int, default=200)
    p.add_argument("--actionable-only", action="store_true")
    p.add_argument("--include-immature", action="store_true")
    p.add_argument("--run-id", default="", help="Firestore doc id (default: generate)")
    p.add_argument(
        "--trigger-source",
        default="workflow_dispatch",
        choices=("ui", "schedule", "workflow_dispatch", "due_check"),
    )
    p.add_argument("--trigger-actor", default="")
    p.add_argument("--notify-slack", action="store_true")
    p.add_argument("--write-local", action="store_true", help="Also write JSON under docs/research/")
    p.add_argument(
        "--due-check",
        action="store_true",
        help="Only run full cohort if latest next_research.due_date <= today (or no prior run).",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="With --due-check, run even if not due.",
    )
    args = p.parse_args(argv)

    load_dotenv(ROOT / ".env", override=False)
    log = _setup_logging()
    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = ROOT / config_path

    since = date.fromisoformat(args.since)
    until = date.fromisoformat(args.until) if str(args.until).strip() else None
    run_id = str(args.run_id).strip() or make_run_id()

    if args.due_check and not args.force:
        latest = latest_succeeded_run()
        today = date.today()
        if latest:
            nr = latest.get("next_research") if isinstance(latest.get("next_research"), dict) else {}
            due_s = str(nr.get("due_date") or "").strip()
            try:
                due_d = date.fromisoformat(due_s) if due_s else None
            except ValueError:
                due_d = None
            if due_d is not None and due_d > today:
                log.info(
                    "Due-check: next research due %s (today %s) — skip full cohort",
                    due_d.isoformat(),
                    today.isoformat(),
                )
                if args.notify_slack:
                    cfg = load_config(config_path)
                    slack_cfg = getattr(cfg, "slack", None)
                    channel = str(
                        getattr(slack_cfg, "channel", "#trading-signals") if slack_cfg else "#trading-signals"
                    )
                    _notify_slack(
                        (
                            f":calendar: Profit-hold research *not due yet* "
                            f"(due {due_d.isoformat()}). Last run `{latest.get('id')}`."
                        ),
                        log,
                        channel_cfg=channel,
                    )
                return 0
            log.info("Due-check: research iteration due (due=%s) — running cohort", due_s or "missing")
            if args.notify_slack:
                cfg = load_config(config_path)
                slack_cfg = getattr(cfg, "slack", None)
                channel = str(
                    getattr(slack_cfg, "channel", "#trading-signals") if slack_cfg else "#trading-signals"
                )
                _notify_slack(
                    (
                        f":alarm_clock: *Research iteration due* "
                        f"(due {due_s or 'n/a'}). Starting profit-hold cohort…"
                    ),
                    log,
                    channel_cfg=channel,
                )
        else:
            log.info("Due-check: no prior succeeded run — running baseline cohort")

    # If Nest pre-created queued stub, preserve created_at
    existing = get_research_run(run_id)
    trigger = {
        "source": str(args.trigger_source),
        "actor": str(args.trigger_actor or "") or None,
    }
    if existing and existing.get("created_at_utc"):
        # merge path will keep fields via set merge
        pass

    return _run_research(
        log=log,
        run_id=run_id,
        since=since,
        until=until,
        actionable_only=bool(args.actionable_only),
        include_immature=bool(args.include_immature),
        limit_runs=int(args.limit_runs),
        config_path=config_path,
        trigger=trigger,
        notify_slack=bool(args.notify_slack),
        write_local=bool(args.write_local),
    )


if __name__ == "__main__":
    raise SystemExit(main())
