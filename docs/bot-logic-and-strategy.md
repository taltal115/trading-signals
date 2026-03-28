## signals-bot: bot logic + trading strategy (signal-only)

This bot is a **signal generator** for **1–7 day swing ideas**. It does **not** place orders. Outputs are:
- terminal logs (BUY/WAIT/SELL with confidence 0–100)
- Slack message (optional)
- SQLite rows (append-only history)

### High-level flow

1) **Load configuration**
- YAML: thresholds, weights, provider order, Slack settings, SQLite path
- Env vars via `.env`: Slack credentials (never committed)

2) **Load universe**
- If `universe.firestore.enabled`: load `symbols` from Firestore collection `universe.firestore.collection` (document id = `asof_date` in `run.timezone`, with optional latest-snapshot fallback).
- Else: `universe.symbols`, `universe.symbols_csv`, and/or `universe.symbols_dir` (CSVs with a `symbol` column)

3) **Fetch daily OHLCV (robust to provider failures)**
- Providers are tried in `data.provider_order` for each ticker.
- Current providers:
  - `yahoo` via `yfinance` (can be blocked on some networks)
  - `stooq` via CSV endpoint (includes HTTP fallback if corporate TLS interception breaks HTTPS verification)

4) **Compute features (daily timeframe)**
From the most recent daily bars:
- **Returns**: 1D / 5D / 10D percent returns
- **Breakout distance**: distance to prior N-day high (default N=20)
- **Volume ratio**: today’s volume / 20-day average volume
- **ATR(14)** and **ATR%**: simple rolling ATR and ATR% of price

5) **Filter + score + classify**
- Filters enforce minimum tradability (price/liquidity/volatility bands).
- The score is turned into **confidence 0–100**.
- The bot emits:
  - **BUY**: breakout + strong momentum + volume surge
  - **WAIT**: interesting but missing one condition
  - **SELL**: only emitted for tickers with an “open BUY” in SQLite when stop/time exit triggers

6) **Persist + notify**
- Every emitted signal is appended into SQLite (`./data/signals.db` by default).
- Slack posts the top-ranked signals above `slack.min_confidence` (optional).

### Strategy: breakout momentum (1–7 days)

This strategy targets names that are:
- near or breaking a **recent high** (continuation setups)
- showing **recent strength** (5D/10D returns)
- trading with **expanded volume** (reduces “random walk” breakouts)

This is generally a better fit than MA20/MA200 cross for 1–7 day “hot runner” ideas, because MA20/MA200 is a slow regime-change signal.

### Default filters (tunable in YAML)

The bot applies these filters for *new ideas*:
- **Price band**: `price_min` … `price_max`
- **Liquidity**: `avg_dollar_vol_min` (close × avg20 volume)
- **Volatility band**: `atr_pct_min` … `atr_pct_max`

If a ticker already has an open BUY (based on SQLite history), exit logic can still run even if the ticker drifts outside the “new idea” filters.

### Score → confidence

The bot computes 3 components scaled to \(0..1\):
- **Breakout component**
  - 1.0 if close >= prior N-day high (breakout)
  - otherwise, decays toward 0 as price is further below the prior high
- **Momentum component**
  - based on 5D and 10D returns relative to configured minimums
- **Volume component**
  - based on volRatio relative to configured minimum

Then it applies weights:
- `weights.breakout`, `weights.momentum`, `weights.volume`

The final score is clamped to \(0..1\), and:
- `confidence = round(score * 100)`

### BUY / WAIT / SELL logic

**BUY** is emitted when all are true:
- close is a **breakout** (>= prior N-day high)
- 5D return >= `ret_5d_min_pct` AND 10D return >= `ret_10d_min_pct`
- volume ratio >= `vol_ratio_min`

**WAIT** is emitted when the ticker passes filters but misses one or more BUY conditions.
The log includes a “why” reason like: `no breakout, weak momentum, low volume`.

**SELL** is emitted only when the bot sees an “open BUY” in SQLite and one of:
- stop hit: close <= stored stop level
- time exit: position age >= `max_hold_days`

### Suggested levels (guidance only)

For BUY signals, the bot suggests:
- `entry`: close
- `stop`: close − (`stop_atr_mult` × ATR14)
- `target`: close + (`target_atr_mult` × ATR14)

These are **not** orders; they’re guidance to keep manual execution consistent.

### SQLite journaling

DB: `sqlite.path` (default `./data/signals.db`)

Tables:
- `runs`: one row per run (run_id, asof_date, timestamps, status, config summary)
- `signals`: one row per emitted signal (BUY/WAIT/SELL)

Stored for each signal:
- action, confidence, score, close, suggested entry/stop/target
- key features (returns, volRatio, ATR%, breakout distance, etc.)
- `metrics_json` (full metrics dict as JSON)

### Scheduling (recommended)

This bot is designed as a **batch job**:
- run once per day after close
- exit

That’s intentional: it’s simpler and more reliable than keeping a long-running process alive.

On macOS, the usual approach is `launchd` (LaunchAgent) to run `./run.sh` daily.

### Data reliability notes

Market data providers can fail (rate limits, blocked networks, TLS interception, outages). The bot:
- tries multiple providers in order
- logs failures per provider
- skips tickers without usable data rather than crashing

