from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from signals_bot.strategy.breakout import OpenBuy, Signal


def _f(x: Any) -> float | None:
    try:
        if x is None:
            return None
        return float(x)
    except Exception:
        return None


class SqliteStore:
    def __init__(self, db_path: str) -> None:
        self.db_path = str(Path(db_path).expanduser())

    def _connect(self) -> sqlite3.Connection:
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(self.db_path)
        con.row_factory = sqlite3.Row
        return con

    def ensure_schema(self) -> None:
        with self._connect() as con:
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS runs (
                  run_id TEXT PRIMARY KEY,
                  asof_date TEXT NOT NULL,
                  started_at_utc TEXT NOT NULL,
                  finished_at_utc TEXT,
                  status TEXT,
                  summary_json TEXT
                )
                """
            )
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS signals (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  run_id TEXT NOT NULL,
                  asof_date TEXT NOT NULL,
                  ts_utc TEXT NOT NULL,
                  ticker TEXT NOT NULL,
                  action TEXT NOT NULL,
                  confidence INTEGER NOT NULL,
                  score REAL NOT NULL,
                  close REAL NOT NULL,
                  suggested_entry REAL,
                  suggested_stop REAL,
                  suggested_target REAL,
                  max_hold_days INTEGER NOT NULL,
                  data_provider TEXT,
                  notes TEXT,
                  ret_1d_pct REAL,
                  ret_5d_pct REAL,
                  ret_10d_pct REAL,
                  vol REAL,
                  avg20_vol REAL,
                  vol_ratio REAL,
                  atr14 REAL,
                  atr_pct REAL,
                  prior_high_n REAL,
                  breakout_dist_pct REAL,
                  open_buy_age_days REAL,
                  open_buy_entry REAL,
                  open_buy_stop REAL,
                  metrics_json TEXT,
                  FOREIGN KEY(run_id) REFERENCES runs(run_id)
                )
                """
            )
            con.execute("CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_signals_asof_action ON signals(asof_date, action)")
            self._ensure_signal_columns(con)

    def _ensure_signal_columns(self, con: sqlite3.Connection) -> None:
        # Minimal “migration”: add missing columns if schema evolves.
        existing = {row["name"] for row in con.execute("PRAGMA table_info(signals)").fetchall()}
        desired: dict[str, str] = {
            "ret_1d_pct": "REAL",
            "ret_5d_pct": "REAL",
            "ret_10d_pct": "REAL",
            "vol": "REAL",
            "avg20_vol": "REAL",
            "vol_ratio": "REAL",
            "atr14": "REAL",
            "atr_pct": "REAL",
            "prior_high_n": "REAL",
            "breakout_dist_pct": "REAL",
            "open_buy_age_days": "REAL",
            "open_buy_entry": "REAL",
            "open_buy_stop": "REAL",
        }
        for col, typ in desired.items():
            if col not in existing:
                con.execute(f"ALTER TABLE signals ADD COLUMN {col} {typ}")

    def start_run(self, *, run_id: str, asof_date: date) -> None:
        with self._connect() as con:
            con.execute(
                "INSERT OR REPLACE INTO runs(run_id, asof_date, started_at_utc, status) VALUES (?, ?, ?, ?)",
                (run_id, asof_date.isoformat(), datetime.now(timezone.utc).isoformat(), "running"),
            )

    def finish_run(self, *, run_id: str, status: str, summary_json: Any) -> None:
        with self._connect() as con:
            con.execute(
                "UPDATE runs SET finished_at_utc=?, status=?, summary_json=? WHERE run_id=?",
                (
                    datetime.now(timezone.utc).isoformat(),
                    status,
                    json.dumps(summary_json, default=str, sort_keys=True),
                    run_id,
                ),
            )

    def insert_signal(self, *, run_id: str, asof_date: date, signal: Signal) -> None:
        m = signal.metrics or {}
        with self._connect() as con:
            con.execute(
                """
                INSERT INTO signals(
                  run_id, asof_date, ts_utc, ticker, action, confidence, score, close,
                  suggested_entry, suggested_stop, suggested_target, max_hold_days,
                  data_provider, notes, metrics_json
                  , ret_1d_pct, ret_5d_pct, ret_10d_pct, vol, avg20_vol, vol_ratio, atr14, atr_pct
                  , prior_high_n, breakout_dist_pct, open_buy_age_days, open_buy_entry, open_buy_stop
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    asof_date.isoformat(),
                    datetime.now(timezone.utc).isoformat(),
                    signal.ticker,
                    signal.action,
                    int(signal.confidence),
                    float(signal.score),
                    float(signal.close),
                    float(signal.suggested_entry) if signal.suggested_entry is not None else None,
                    float(signal.suggested_stop) if signal.suggested_stop is not None else None,
                    float(signal.suggested_target) if signal.suggested_target is not None else None,
                    int(signal.max_hold_days),
                    signal.data_provider,
                    signal.notes,
                    json.dumps(m, default=str, sort_keys=True),
                    _f(m.get("ret_1d_pct")),
                    _f(m.get("ret_5d_pct")),
                    _f(m.get("ret_10d_pct")),
                    _f(m.get("vol")),
                    _f(m.get("avg20_vol")),
                    _f(m.get("vol_ratio")),
                    _f(m.get("atr14")),
                    _f(m.get("atr_pct")),
                    _f(m.get("prior_high_n")),
                    _f(m.get("breakout_dist_pct")),
                    _f(m.get("open_buy_age_days")),
                    _f(m.get("open_buy_entry")),
                    _f(m.get("open_buy_stop")),
                ),
            )

    def _last_action_ts(self, *, ticker: str, action: str) -> tuple[str, sqlite3.Row] | None:
        with self._connect() as con:
            row = con.execute(
                "SELECT * FROM signals WHERE ticker=? AND action=? ORDER BY ts_utc DESC LIMIT 1",
                (ticker, action),
            ).fetchone()
            if not row:
                return None
            return row["ts_utc"], row

    def get_open_buy(self, ticker: str) -> OpenBuy | None:
        last_buy = self._last_action_ts(ticker=ticker, action="BUY")
        if not last_buy:
            return None

        last_sell = self._last_action_ts(ticker=ticker, action="SELL")
        if last_sell and last_sell[0] >= last_buy[0]:
            return None

        buy_row = last_buy[1]
        buy_date = date.fromisoformat(buy_row["asof_date"])
        entry = float(buy_row["suggested_entry"] or buy_row["close"])
        stop = float(buy_row["suggested_stop"]) if buy_row["suggested_stop"] is not None else None
        return OpenBuy(ticker=ticker, buy_asof_date=buy_date, entry=entry, stop=stop)

