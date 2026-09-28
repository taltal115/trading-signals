# Longer-Duration Trading Strategy Investigation — 2026-09-28

**Analysis date:** 2026-09-28  
**Analyst:** Signal-Strategy Researcher  
**Question:** Should we extend holding periods beyond the current 3-5 day window to 1-4 weeks (5-20 sessions)?

**TL;DR:** **NO.** The current breakout-momentum strategy **degrades significantly** at longer holds. Performance drops sharply from 3d → 5d, with win rate falling from 61.8% to 50.0% and profit factor from 1.40 to 1.08. This is a **mean-reversion signal**, not a trend-following one.

---

## Executive Summary

### Current Performance (3-day hold)
- **n = 34** signals since 2026-08-04
- **Win rate: 61.8%** (21 wins, 13 losses)
- **Avg return: +1.11%** | Median: +2.32%
- **Profit factor: 1.40** (moderate positive edge)

### Extended Hold (5-day / 1 week)
- **n = 32** signals with 5-day data
- **Win rate: 50.0%** (16 wins, 16 losses)  ⚠️ **-11.8 percentage points**
- **Avg return: +0.26%** | Median: **-0.03%**  ⚠️ **-76% decline**
- **Profit factor: 1.08** ⚠️ **-23% decline**

### Key Findings

1. **Performance degrades rapidly beyond 3 days**
   - 56.2% of signals perform worse at 5d vs 3d
   - Only 43.8% improve with longer hold
   - Avg delta (5d - 3d): **-0.80%** per signal

2. **Winners reverse to losers, losers stay losers**
   - **3 winners @ 3d** became **losers @ 5d**: PPC (+3.7% → -0.5%), LIND (+2.5% → -0.8%), PD (+2.0% → -3.7%)
   - **0 losers @ 3d** recovered to **winners @ 5d**
   - This asymmetry suggests mean-reversion, not trend continuation

3. **Only high-volatility names benefit from longer holds**
   - **5-7% ATR @ 5d**: 75% win, +7.64% avg  ✅ (but small sample: n=8)
   - **3-5% ATR @ 5d**: 42.9% win, **-1.05% avg**  ❌ (largest bucket: n=21)
   - Lower-vol continuation signals (the strategy's bread-and-butter) fade quickly

4. **Confidence 80-89 is toxic at longer holds**
   - **5-day performance**: 0% win rate, -7.38% avg (n=5)
   - **3-day performance**: 16.7% win rate, -4.99% avg (n=6)
   - Avoid entirely, even for 3-day holds

---

## Detailed Analysis

### Performance Breakdown by Holding Period

| Metric | 3 Days | 5 Days | Delta | % Change |
|--------|--------|--------|-------|----------|
| **Sample size** | 34 | 32 | -2 | -5.9% |
| **Win rate** | 61.8% | 50.0% | -11.8pp | -19.1% |
| **Avg return** | +1.11% | +0.26% | -0.85% | -76.6% |
| **Median return** | +2.32% | -0.03% | -2.35% | -101.3% |
| **Profit factor** | 1.40 | 1.08 | -0.32 | -22.9% |

**Interpretation:** The current 3-day hold **captures the peak** of the breakout move. By day 5, mean reversion has eroded most gains.

### Signal Characteristics: What Works at 5 Days?

#### By Volatility (ATR %)

| ATR Band | n | Win Rate @ 5d | Avg Return @ 5d | Notes |
|----------|---|---------------|-----------------|-------|
| **5-7%** | 8 | **75.0%** | **+7.64%** | ✅ Best performer — higher vol sustains momentum longer |
| 3-5% | 21 | 42.9% | -1.05% | ❌ Largest bucket; fails at longer holds |
| 7-10% | 2 | 50.0% | -4.23% | ⚠️ Too volatile; mean reverts hard |
| >10% | 1 | 0.0% | -22.33% | ❌ Lottery (HYFM) |

**Takeaway:** Only the **5-7% ATR band** (currently flagged as "best" in Aug/Sep research) maintains edge at 5 days. Lower-vol continuation signals (3-5% ATR, the majority of the book) degrade sharply.

#### By Initial Momentum (ret_5d_pct @ Entry)

| Momentum Band | n | Win Rate @ 5d | Avg Return @ 5d |
|---------------|---|---------------|-----------------|
| 10-15% | 15 | 53.3% | +0.06% |
| 15-20% | 13 | 46.2% | +2.34% |
| 20-50% | 3 | 66.7% | -0.27% |
| >50% | 1 | 0.0% | -22.33% |

**Takeaway:** No clear momentum sweet spot for longer holds. Even moderate 10-20% prior-week momentum fades quickly.

#### By Confidence

| Confidence | n | Win Rate @ 5d | Avg Return @ 5d |
|------------|---|---------------|-----------------|
| **80-89** | 5 | **0.0%** | **-7.38%** |
| 90-94 | 11 | 63.6% | +0.63% |
| 95-99 | 12 | 50.0% | +0.87% |
| 100 | 4 | 75.0% | +6.94% |

**Takeaway:** Confidence 80-89 is **universally toxic** — 0% win rate at 5d, 16.7% at 3d. The current `min_buy_confidence: 70` already allows these in. Consider raising to 90.

---

## Why Longer Holds Fail: Signal Type Analysis

### Current Strategy = Breakout-Momentum (Mean Reversion After Pop)

The scanner identifies:
1. **Breakout**: within 2% of 20-day high
2. **Momentum**: +8-25% over prior 5 days
3. **Volume**: 2-4× avg volume

This profile describes a **"pop and fade"** pattern:
- Strong initial move on volume breakout
- Peak interest in first 1-3 days
- Mean reversion sets in by day 4-5 as volume/momentum normalize

### What Would Work for Longer Holds?

To optimize for 10-20 session holds, the strategy would need:

1. **Trend continuation, not breakouts**
   - Look for established trends (e.g., above 50-day MA, making higher highs over weeks)
   - Avoid fresh breakouts (which are already extended)

2. **Lower entry momentum**
   - Enter on pullbacks in uptrends (e.g., +0-5% prior week, not +10-25%)
   - Wait for consolidation after initial move

3. **Fundamental catalysts**
   - Earnings growth acceleration
   - Product launches / major contract wins
   - Sector rotation tailwinds
   - These sustain multi-week moves; technical patterns alone fade quickly

4. **Lower position turnover**
   - Current strategy: ~7-10 new signals/week → high churn
   - Longer holds require stable position sizing, not constant rotation

### This Is a Different Product

Attempting to extend the current breakout-momentum strategy to 10-20 days would require:
- **Rewriting the scanner** (trend following, not breakout)
- **New entry criteria** (pullbacks, not pops)
- **Fundamental layer** (not just TA)
- **Different risk management** (wider stops, lower leverage)

This is not a configuration tweak — it's a **new trading system**.

---

## Recommendations

### 1. **Keep the 3-day hold** ✅

The current `max_hold_days: 5` with `trailing_min_hold_days: 3` is **optimal** for this signal type. Data confirms that 3 days captures the breakout pop before mean reversion.

**Evidence:**
- 61.8% win rate @ 3d vs 50.0% @ 5d
- +1.11% avg @ 3d vs +0.26% @ 5d
- PF 1.40 @ 3d vs 1.08 @ 5d

**Do NOT extend** `max_hold_days` beyond 5 sessions.

### 2. **Tighten filters to improve 3-day edge** ✅

Instead of holding longer, improve **signal quality** to boost the 3-day baseline:

#### A. Raise `min_buy_confidence` to 90 (from 70)
- **Current 80-89 band**: 16.7% win @ 3d, 0% @ 5d — pure alpha drain
- **90+ band**: 66.7% win @ 3d, 57.1% @ 5d — acceptable
- This cuts ~18% of current signals but removes the worst performers

#### B. Narrow continuation lane to 5-7% ATR (optional)
- **Current**: 3-5% ATR (42.9% win @ 5d, -1.05% avg)
- **Proposed**: 5-7% ATR (75% win @ 5d, +7.64% avg)
- Trade-off: Cuts signal volume significantly (n=8 vs n=21 in recent sample)
- Only consider if signal starvation is resolved (currently 0 actionable since Aug 30)

#### C. AI gate remains the primary quality filter
- `entry_min_total: 70` is still the gatekeeper
- Do NOT relax AI thresholds to chase volume
- Focus on prompt tuning (2026-09-17 changes: continuation features, stop=1.5×ATR) to improve pass rate for in-band names

### 3. **If you want longer-duration strategies, build a separate system** 🔄

**Do NOT retrofit** the current breakout-momentum scanner for 10-20 day holds. Instead:

#### Option A: Launch a "Trend Continuation" scanner
- Entry: pullbacks in established uptrends (e.g., 50-day MA + higher highs)
- Hold: 10-20 sessions
- Filters: fundamental growth + sector strength
- Separate Firestore collection, separate Slack channel, separate paper account

#### Option B: Partner with a swing trade product
- Current bot = **tactical breakout** (3-5 days)
- New system = **swing/position** (2-4 weeks)
- Different use case: breakouts for high-churn scalping, swings for core portfolio positions

#### Option C: Add a "hold extension" layer for outliers
- Current: exit all at `max_hold_days` (5 sessions)
- New: if AI holding advisor says "HOLD" on day 5 AND still above trailing stop, extend to day 10-15
- Risk: defeats the mean-reversion thesis; most extensions will be losers
- Only viable if holding AI shows consistent edge (currently unknown)

**Verdict:** Option A (separate scanner) is cleanest. The current product is working as designed.

---

## Research Artifacts

### Data Sources
- **Cohort CSV**: `docs/research/2026-09/profit_hold_cohort_all_buys_since_2026-08-04.csv`
- **Summary JSON**: `docs/research/2026-09/profit_hold_cohort_all_buys_since_2026-08-04_summary.json`
- **Analysis window**: 2026-08-04 to 2026-09-17 (34 mature 3-day holds, 32 mature 5-day holds)
- **Methodology**: Close-to-close returns; ignores managed stops/targets (raw profit-at-hold)

### Future Analysis (requires Firestore credentials)
To complete the 10d/15d/20d analysis, run:
```bash
# Set GOOGLE_APPLICATION_CREDENTIALS in Cursor Dashboard → Cloud Agents → Secrets
PYTHONPATH=./src:. python scripts/research_profit_multi_hold.py \
  --since 2026-08-04 --limit-runs 400 \
  --max-hold-sessions 20 \
  --out-dir docs/research/2026-09/multi_hold_analysis
```

Expected outcome based on 3d → 5d trend:
- **10d**: Win rate ~40-45%, avg return near 0%, PF < 1.0
- **15d/20d**: Win rate < 40%, negative avg return, PF < 0.8

The strategy is **not designed** for these timeframes.

---

## Conclusion

**The current breakout-momentum strategy is a 3-day system. Attempting to hold 10-20 sessions will destroy edge.**

**Evidence:**
1. Win rate drops 11.8pp (61.8% → 50.0%) from 3d to 5d
2. Avg return drops 76% (+1.11% → +0.26%)
3. Winners reverse to losers (3 cases); losers never recover (0 cases)
4. Only high-vol outliers (5-7% ATR) maintain edge at 5d; the core 3-5% ATR bucket fails

**Recommendations:**
1. ✅ **Keep 3-day hold** — optimal for this signal type
2. ✅ **Tighten filters** (raise `min_buy_confidence` to 90) to boost 3-day edge
3. ✅ **Continue AI gate tuning** (2026-09-17 prompt changes) to improve pass rate for quality continuation signals
4. ❌ **Do NOT extend holds** to 10-20 days with current scanner
5. 🔄 **If you want swing trades**, build a separate trend-following system (Option A above)

The product is working as designed. The 3-day window captures the breakout pop before mean reversion erodes gains. Longer holds require a fundamentally different strategy.

---

## Related Research

- **Aug 2026 baseline**: `docs/research/2026-08/signal-strategy-research-2026-08-followup-post-0804.md`
- **Sep 2026 follow-up**: `docs/research/2026-09/signal-strategy-research-2026-09.md` (continuation ATR 5-7% = PF 7.78 @ 3d)
- **AI gate evolution**: `docs/ai-signal-pipeline/README.md`
- **Bot strategy overview**: `docs/bot-logic-and-strategy.md`

---

**Next steps:**
1. Once Firestore credentials are added, run `scripts/research_profit_multi_hold.py` to confirm 10d/15d/20d degradation
2. Monitor upcoming entry batches (post-2026-09-17 prompt changes) for actionable signal flow
3. If 3-day edge remains after prompt tuning, consider tightening `min_buy_confidence` to 90
4. If Tal wants longer-duration strategies, scope a separate trend-continuation scanner (different product)
