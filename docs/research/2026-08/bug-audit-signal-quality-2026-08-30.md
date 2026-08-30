# Bug audit — signal quality & measurement fixes (2026-08-30)

Full-codebase correctness review of the signal pipeline (scan → AI entry gate →
paper/holding → monitor → research). Fixes shipped in the same PR as this note.
None of these change strategy thresholds; they fix code that was not doing what
the config/research said it was doing.

## Live pipeline bugs (affect which signals become actionable)

| # | Bug | Impact | Fix |
|---|-----|--------|-----|
| 1 | Entry prompt `Gap: {{gap_pct}}%` rendered the 0–100 `gap_strength` feature (`abs(gap)*6`), not the gap percent | LLM saw a 2% gap as "12%", 8% as "48%" → biased entry verdicts on every eval | `scripts/ai_stock_eval/features.py` now passes the raw gap percent |
| 2 | Bearish keyword `"sec"` matched as substring ("sector", "second", "securities") | Spurious bearish sentiment → lower total score → good signals filtered | Word-boundary regex matching; modest keyword variants added |
| 3 | `{{deterministic_score}}` showed `price_strength*100` only | Misleading "Deterministic Score" in prompt | Now shows the actual weighted deterministic sum used in scoring |
| 4 | LLM conviction returned on a 0–100 scale clamped to 1.0 | Any "conviction: 70" style answer became conviction 1.0 → auto-passed the ≥0.7 gate | Values > 1.5 are treated as percent and divided by 100 |
| 5 | Missing `OPENAI_API_KEY` produced a stub WAIT verdict that was **persisted** as `ai_gate=filtered` | Top-N pending signals permanently burned with no real eval | Stub verdicts are never persisted; gate stays `pending`, exit code 1 |
| 6 | Short-direction verdict could still `ai_gate=passed` | Long-only book could open a long paper position on a short thesis | `resolve_ai_gate` filters `direction=short` |
| 7 | AI plan overrides accepted stop ≥ close / target ≤ close | Inverted bracket became the paper plan; monitor could never exit correctly | Sanity check: stop below entry, target above |
| 8 | `ai_gate=passed` committed before the paper upsert; upsert failure left "passed with no paper" | Actionable signal with no ledger position; never retried | On upsert failure the gate rolls back to `pending` and the error propagates |
| 9 | One crashed ticker aborted the whole entry batch loop | Remaining pending signals never evaluated that day | Per-ticker try/except in the batch loop |
| 10 | Holding advisor read `stop_price` before `ai_revised_stop` | TIGHTEN advice never reached later prompts (monitor already used the right order) | Revised stop takes precedence |
| 11 | Holding advisor used `current = entry` when the quote failed | Fake 0% PnL nudged the model toward HOLD | Skip the eval this run; retry next cron |
| 12 | Holding advisor had no per-position error handling | One 429/5xx aborted the rest of the book | Rate limit stops the batch cleanly; other errors skip the position |
| 13 | `close_signal_paper_position` could store `"ai_gate=filtered"` (reason string) as the `ai_gate` value | Broken filters/joins on gate values | Explicit `gate` parameter; value stays a real gate |
| 14 | Paper positions opened with empty `asof_date` | Paper ↔ signal-day joins broken | Run `asof_date` passed into the upsert |
| 15 | Slack AI-passed ordering used an ad-hoc sort | Slack top-N diverged from the canonical `signal_quality` rank (no conf-band demotion) | Uses `buy_rank_key_from_row` with config thresholds |
| 16 | Entry batch ranking didn't thread config conf-band thresholds | YAML changes to conf bands would silently not affect LLM top-N selection | Thresholds threaded through `list_pending_tickers` |
| 17 | Primary target picked T2 when the model listed it before T1 | Paper/UI target ~2R instead of T1 | Explicit T1 preference, else first positive target |

## Measurement bugs (distort the research that tunes thresholds)

| # | Bug | Impact | Fix |
|---|-----|--------|-----|
| 18 | `research_open_signals` finalized "time" exits pre-open on the deadline day (deadline bar absent) | Permanent outcome locked one session early | Require the deadline bar; finalize early only when bars exist past the deadline (data gap) |
| 19 | Backtests booked "time" exits on incomplete forward windows | Missing/short data counted as completed holds — optimistic (losers halt/delist more) | Incomplete windows → `no_data` |
| 20 | Same-day dedupe kept the **earliest** run; AI writes gates to the **latest** run doc | `--actionable-only` cohorts undercounted (rows stuck `pending`) | Cohort script dedupes to the latest run |
| 21 | Missing price history silently dropped rows from cohort stats | Survivorship bias (higher win rate / PF) | `n_data_error` counted, warned, and reported in the summary JSON |
| 22 | Maturity filters used UTC `date.today()` + calendar days | Off-by-one vs NY date; sessions ≠ calendar days over weekends/holidays | NY market date + NYSE session counting |
| 23 | Monitor fired `DURATION_DUE` at the ATR plan-hold (day 2) without the trailing test | Paper exits earlier than the live strategy (which only time-exits at the max-hold ceiling) | Plan-due applies the trailing ride test; hard ceiling unchanged |

## Reviewed and left as-is (deliberate design)

- Managed backtests use intraday high/low bracket fills and check stop before
  target in the same bar — documented "managed ledger" methodology, distinct
  from live close-only stops. A live-parity simulation mode (close-only stop,
  trailing, no target) is a possible follow-up but is a methodology change,
  not a bug fix.
- `vol_ratio` includes the current bar in the 20-day average volume. The
  continuation band [2, 3) was calibrated against this definition; changing it
  would silently invalidate the tuned thresholds.
- Entry price = signal close (next open ≈ prior close) — documented research
  convention.
- IBKR holdings fetch failure degrades to "no holdings gate" — intentional
  graceful degradation.
- Yahoo `auto_adjust=False`: Yahoo raw closes are split-adjusted (dividends
  are not); switching to adjusted closes would re-calibrate every threshold.

## Verification

`scripts/test_signal_fixes.py` (15 tests) covers: conviction rescaling, T1
selection, short-direction gate, gap placeholder, `"sec"` sentiment matching,
finalizer deadline-bar requirement, backtest incomplete-window handling, and
monitor trailing-clock alignment. Existing calendar/gateway tests still pass.

After a few actionable cohorts accumulate under the fixed pipeline, remeasure
with `scripts/research_profit_hold_cohort.py --actionable-only` — note that the
dedupe fix (#20) alone will change reported actionable counts vs earlier runs.
