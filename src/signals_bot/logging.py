from __future__ import annotations

import logging
from dataclasses import asdict
from typing import Any

from rich.logging import RichHandler


def get_logger(level: str = "INFO") -> logging.Logger:
    logger = logging.getLogger("signals-bot")
    if logger.handlers:
        return logger

    logger.setLevel(level.upper())
    handler = RichHandler(rich_tracebacks=True, markup=True, show_time=True, show_level=True, show_path=False)
    formatter = logging.Formatter("%(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.propagate = False
    return logger


def log_run_header(logger: logging.Logger, *, run_id: str, config_path: str) -> None:
    logger.info("[bold]signals-bot[/] starting")
    logger.info("run_id=%s", run_id)
    logger.info("config=%s", config_path)


def _fmt_money(x: float | None) -> str:
    if x is None:
        return "-"
    return f"${x:,.2f}"


def _fmt_pct(x: float | None) -> str:
    if x is None:
        return "-"
    return f"{x:,.2f}%"


def log_signal(logger: logging.Logger, signal: Any) -> None:
    # Accepts signals_bot.strategy.breakout.Signal (keeps logger decoupled).
    tag = signal.action
    if tag == "BUY":
        tag_s = "[bold green]BUY[/]"
    elif tag == "SELL":
        tag_s = "[bold red]SELL[/]"
    else:
        tag_s = "[bold yellow]WAIT[/]"

    metrics = getattr(signal, "metrics", {}) or {}
    close = getattr(signal, "close", None)
    vol_ratio = metrics.get("vol_ratio")
    ret_5d = metrics.get("ret_5d_pct")
    breakout_dist = metrics.get("breakout_dist_pct")
    atr_pct = metrics.get("atr_pct")

    logger.info(
        "%s %s conf=%d score=%.3f close=%s volRatio=%.2f ret5=%s brkDist=%s atr=%s :: %s",
        tag_s,
        signal.ticker,
        int(signal.confidence),
        float(signal.score),
        _fmt_money(close),
        float(vol_ratio) if vol_ratio is not None else 0.0,
        _fmt_pct(ret_5d),
        _fmt_pct(breakout_dist),
        _fmt_pct(atr_pct),
        signal.notes,
    )

    logger.debug("signal_details=%s", asdict(signal))

