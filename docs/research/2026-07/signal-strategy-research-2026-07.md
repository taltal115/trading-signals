# Signal strategy research — July 2026

> **Superseded (universe eligibility, Jul 2026+):** Discovery `active` is no longer BUY-only. Current rule: **BUY** (≥ `--min-confidence`) **or high-setup WAIT** (≥ `--watch-min-confidence`), with explicit statuses (`inactive_below_min`, `inactive_wait`, `inactive_sell`, …), `status_counts`, and **no** silent empty-`active_symbols` → full history fallback. Historical tables below still describe the older BUY-only era.

Research notes from investigating universe discovery, historical BUY performance, the STAK case study, strategy refactors, and the first post-refactor signal cohort (2026-06-28).

**Data sources:** local SQLite (`data/signals.db`), Firestore (`signals`, `universe`), Yahoo Finance price history.

**Scripts used / added:** `scripts/backtest_buy_signals.py` (historical BUY backtest).

---

## Executive summary

| Period | Cohort | Win rate | Avg return | Profit factor |
|--------|--------|----------|------------|---------------|
| Pre-refactor | 110 BUYs (Jan–Jun 2026) | 47.3% | +0.09% | 1.02 |
| Post-refactor caps | 63 kept after overextension filter | 50.8% | +1.31% | 1.46 |
| Post-refactor | 53 BUYs from 2026-06-28 run (+3 sessions) | **66.0%** | **+2.15%** | **2.51** |

The pre-refactor strategy was roughly break-even. Overextension caps and threshold tuning improved quality on historical data. The first large post-refactor scan (54 signals on 2026-06-28, all with 3-day hold) shows a much stronger early cohort — though it is a single day, one market regime, and only ~4 forward sessions were available at analysis time.

---

## 1. Universe discovery — gate blocking runs

### Problem

GitHub Actions workflow `universe-discovery-daily.yml` used a time gate (`gate_ok=False` when NY time was not ~07:30 ET). Scheduled runs completed but skipped checkout, Python setup, and **Run universe discovery**.

### Fix

- Removed the Gate step and all `if: steps.gate.outputs.run == 'true'` conditions.
- Simplified schedule to a single cron (`30 11 * * 1-5`).

### Active vs inactive symbols

Discovery tags each symbol:

| Status | Meaning |
|--------|---------|
| `active` | BUY this run, passed filters, in top-K |
| `inactive_failed` | No signal or no price data |
| `inactive_low_conf` | WAIT/SELL or BUY below min confidence |
| `inactive_stale` | Too many inactive runs / too long since active |
| `inactive_capped` | Passed strategy but outside top-K |

Example log (2026-06-24) before BUY-only discovery logic:

```
today_pass=647  revalidate_pass=111  low_conf=757  active=0
```

Providers were working; most “passes” were WAIT signals filtered by `--min-confidence 85`. Discovery was later changed to **BUY-only** for active eligibility (`--min-confidence 50` in CI).

---

## 2. Historical BUY backtest (Jan–Jun 2026)

**Script:** `scripts/backtest_buy_signals.py`  
**Input:** 113 BUY rows in `data/signals.db` (110 with enough forward data).

### Overall (managed trade: stop 1.5×ATR, target 3×ATR, hold up to `max_hold_days`)

| Metric | Value |
|--------|-------|
| Trades | 110 |
| Win rate | 47.3% |
| Avg return | +0.09% |
| Median return | −0.78% |
| Profit factor | 1.02 |
| Hit target | 13 |
| Hit stop | 40 |
| Time exit | 57 |

**Conclusion:** Exit tuning alone could not fix performance (best parameter sweep still negative average return). The issue was **entry selection**, not stop/target/hold.

### What predicted outcomes

| Factor | Finding |
|--------|---------|
| **Confidence** | Not predictive. `<85` conf: 57% win, +4.1% avg. `95–100`: ~33–54% win. |
| **ret_5d** | Lower better. `10–20%`: 53% win, PF 1.41. `>50%`: 41% win, PF 0.72. |
| **ret_10d** | `>60%`: worst bucket (32% win, −2.34% avg). |
| **ATR%** | `3–5%`: best (56% win, PF 1.75). `5–7%`: worst (38% win). |
| **vol_ratio** | Mild edge for `≥5×` vs `2–3×`. |

### Overextension caps (implemented)

Caps: `ret_5d_max_pct: 30`, `ret_10d_max_pct: 60`.

| | n | Win% | Avg | PF |
|--|---|------|-----|-----|
| All trades | 110 | 47.3 | +0.09% | 1.02 |
| Kept (within caps) | 63 | 50.8 | +1.31% | 1.46 |
| Rejected (overextended) | 47 | 42.6 | −1.56% | 0.72 |

---

## 3. STAK case study (2026-06-04)

Rare strong signal; used to derive “volume ignition” and fresh-breakout bypass rules.

### Firestore signal

| Field | Value |
|-------|-------|
| asof_date | 2026-06-04 (entry from 2026-06-03 close) |
| Entry | $3.61 |
| Stop | $2.904 (−19.6%) |
| Target | $5.023 (+39.1%) |
| Confidence | 100% |
| Notes | breakout + momentum + volume |

### Two-day pattern

**2026-06-02 — volume ignition (day 1)**  
+95% 1-day, ~9× volume, still ~22% below 20-day high. Old algo: missed (price &lt; $2 min, ATR 19%, no breakout yet).

**2026-06-03 — breakout (day 2)**  
Broke to $3.61, 5.4× volume. Old algo: BUY conf=100. Recent tuning had blocked (ATR cap 12%, overextension).

**After entry**  
- 2026-06-04: ~$4.27 (+18%) — matches dashboard mark.  
- 2026-06-05: low $2.76 → **stop hit** (−19.6%) with disciplined exit.  
- Peak ~$8.80 on 6/5 — huge upside only with perfect timing.

### Strategy rules added (STAK-derived)

1. **`overextension_bypass_vol_ratio: 5.0`** — at/above 20d high with vol ≥ 5× avg: skip ret_5d/10d max caps.  
2. **Volume ignition** — `ignite_vol_ratio_min: 8`, `ignite_ret_1d_min_pct: 50`, `ignite_prior_high_dist_pct_max: 25`, `ignite_atr_pct_max: 20`, `ignite_price_min: 1.0`.  
3. **`atr_pct_max: 14`** — STAK had 13% ATR on breakout day.

Replay with new config:

```
2026-06-02  BUY  volume ignition + momentum + volume  @ $1.90
2026-06-03  BUY  breakout + momentum + volume         @ $3.61
2026-06-04  WAIT low volume, overextended
```

---

## 4. Config changes (strategy refactor)

| Parameter | Before | After |
|-----------|--------|-------|
| `min_buy_confidence` | 85 | 70 |
| `slack.min_confidence` | 85 | 70 |
| `ret_5d_min_pct` | 12 | 8 |
| `ret_10d_min_pct` | 18 | 12 |
| `vol_ratio_min` | 3.0 | 2.0 |
| `breakout_dist_pct_max` | 0.8 | 2.0 |
| `avg_dollar_vol_min` | 10M | 5M |
| `atr_pct_min` / `atr_pct_max` | 3 / 14 | 2 / 14 |
| `target_atr_mult` | 3.0 | 2.5 |
| `ret_5d_max_pct` / `ret_10d_max_pct` | — | 30 / 60 |
| `overextension_bypass_vol_ratio` | — | 5.0 |
| `ignite_*` | — | see STAK section |
| Universe discovery `--min-confidence` | 85 | 50 (BUY-only) |

**Hold period:** post-2026-06-28 runs use static **3-day** hold (was often 5 days or ATR-derived 2–5).

---

## 5. Post-refactor cohort — 2026-06-28

**Source:** Firestore `signals` collection, run `asof_date: 2026-06-28`.  
**Count:** 54 BUY signals (53 evaluated; MEG missing Yahoo data).  
**Excluded:** 2026-07-02 batch (no forward sessions yet at analysis date).

### Method

- Buy at bot entry (`close` = suggested entry).  
- Measure **raw close** after 3 and 5 **NYSE trading sessions** (5d partial: only 4 sessions available through 2026-07-02).  
- **Managed:** stop (low ≤ stop) then target (high ≥ target), else exit at 3-session close; same-session stop assumed first (conservative).

### Results

| Case | n | Win rate | Avg return | Median | PF |
|------|---|----------|------------|--------|-----|
| Raw close +3 sessions | 53 | **66.0%** | **+2.15%** | +2.51% | 2.51 |
| Raw close +5 sessions* | 53 | 66.0% | +2.34% | +2.39% | 2.39 |
| Managed (3d hold) | 53 | 66.0% | +2.20% | +2.51% | 2.52 |

\*Partial forward window.

**Managed outcomes:** 7 target, 7 stop, 39 time exit.

### Top / bottom (+3 sessions)

**Winners:** PRCH +15.1%, ODD +14.5%, GH +14.4%, LFST +11.2%, PUBM +9.3%.  
**Losers:** LIND −9.5%, LXRX −8.2%, MAMA −8.1%, LGIH −7.6%, GVA −6.6%.

### Confidence vs return (+3d)

| Confidence | n | Win% | Avg |
|------------|---|------|-----|
| 80–89 | 10 | 90.0% | +3.88% |
| 90–94 | 17 | 52.9% | +1.65% |
| 95–99 | 13 | 69.2% | +0.37% |
| 100 | 13 | 61.5% | +3.25% |

Confidence remains a weak ranker; mid-tier conf (80–89) outperformed 95–99.

---

## 6. Recommendations

### Implemented or in config

- Overextension caps + fresh-breakout volume bypass.  
- Volume ignition for day-before-breakout entries.  
- Lower entry floors, BUY-only universe discovery, 3-day hold.  
- Target 2.5×ATR (3× was rarely hit historically).

### Next experiments

1. **Trailing exit** — 74% of 6/28 cohort exited on time; +5d avg &gt; +3d for several names. Trail after entry (e.g. prior session low) up to 5 sessions.  
2. **Keep stop at 1.5×ATR** — all stopped names remained losers at day 5.  
3. **Rank signals for Slack/top-N** by “least overextended” (lower ret_5d among BUYs), not confidence.  
4. **Re-measure 6/28 at full +5 sessions** and track 2026-07-02 batch when mature.  
5. **Automate cohort tracking** — extend `scripts/backtest_buy_signals.py` or add `scripts/backtest_recent_signals.py` for Firestore runs by `asof_date`.

### Implementation log (2026-07-04)

All five "next experiments" above were implemented:

| # | Change | Where |
|---|--------|-------|
| 1 | Trailing exit: once held ≥ `trailing_min_hold_days` (3) and profitable and above the prior session's low, keep riding up to `max_hold_days` (5); otherwise exit. Applied to both the SQLite re-buy exit path and the real position monitor's `DURATION_DUE` alert. | `strategy/breakout.py` (`generate_signal`), `scripts/monitor_open_positions.py` (`_eval_position`), new `strategy.trailing_min_hold_days` config |
| 2 | Stop left at 1.5×ATR (unchanged) — confirmed correct by the data, no action needed. | `config.yaml` |
| 3 | Slack/Firestore ranking now sorts BUYs by ascending `ret_5d_pct` (least-overextended first); confidence is only a tiebreaker. | `main.py` (`_signal_rank_key`) |
| 4 | Use `scripts/backtest_recent_signals.py` (below) to re-measure any cohort at +3/+5 (or custom) sessions once it matures. | — |
| 5 | New `scripts/backtest_recent_signals.py` pulls BUYs from Firestore for a date/range, reports raw and managed win-rate at N sessions, and can append a summary row to `docs/research/cohort_tracking.csv` for tracking over time. | `scripts/backtest_recent_signals.py` |

Also tightened the standard `atr_pct_max` from 14 → 10 (bucket data: 3–5% ATR won 56%/PF 1.75, 5–7% won only 37%/PF 0.78, 10%+ was worst). High-volume fresh breakouts (STAK-style, `vol_ratio ≥ overextension_bypass_vol_ratio`) and volume-ignition entries still get the wider `ignite_atr_pct_max` (20) ceiling, so the STAK case study rules are unaffected — verified both STAK 2026-06-02 (ignition) and 2026-06-03 (fresh breakout) still produce BUY signals under the new config.

Run the cohort tool going forward, e.g.:

```bash
python scripts/backtest_recent_signals.py --since 2026-06-28 --sessions 3,5 --append-csv
```

### Automated per-signal finalization (2026-07-09)

Added `scripts/research_open_signals.py` + `.github/workflows/signal-research-daily.yml`
(weekdays 12:00 UTC, before the 09:30 ET open). For every signal whose hold window
(`asof_date` + `hold_days` NYSE sessions) has ended, it re-fetches history, runs the same
managed-trade walk as the backtest scripts (stop → target → time exit), and writes a
**permanent** outcome directly onto the signal entry in Firestore: `isProfitable`, `pnlValue`,
`pnlPct`, `livePrice` (realized exit price), `outcome` (`target`/`stop`/`time`/`no_data`),
`exitDate`, `reason`, and `researchStatus` (`"finalized"` once written). Already-finalized
signals are always skipped, so it's safe to run daily and doubles as a one-off historical
backfill (`--lookback-days` controls how far back it scans). The Signals dashboard table
dropped the redundant `entry` and `conf` columns in favor of a single `status` badge
(Profit/Loss/Flat/Pending) sourced from these fields, plus a `pnlPct` readout next to the live
price.

### Caveats

- Single-day cohort (6/28) and short forward window.  
- STAK-style bypass trades dilute historical PF slightly when added to overextension-rejected bucket — use selectively.  
- Managed P&amp;L assumes stop fills before target on same bar when both touched.

---

## Appendix: commands

```bash
# Historical BUY backtest (SQLite)
PYTHONPATH=./src python scripts/backtest_buy_signals.py --csv data/backtest_buys.csv

# Local discovery (verbose)
./run.sh discovery --max-calls 50 --merge-days 7 -v
```

**Related docs:** `docs/bot-logic-and-strategy.md`, `README.md` (universe active/inactive).

**Analysis date:** 2026-07-04.
