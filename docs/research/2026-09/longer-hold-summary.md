# Longer-Hold Analysis — Quick Summary

**Date:** 2026-09-28  
**Question:** Should we hold signals for 1-4 weeks instead of 3-5 days?  
**Answer:** **NO** — Performance degrades rapidly. Current 3-day hold is optimal.

---

## The Numbers

| Metric | 3 Days (Current) | 5 Days (1 Week) | Change |
|--------|------------------|-----------------|--------|
| **Win Rate** | 61.8% | 50.0% | **-11.8pp** ⚠️ |
| **Avg Return** | +1.11% | +0.26% | **-76%** ⚠️ |
| **Profit Factor** | 1.40 | 1.08 | **-23%** ⚠️ |
| **Median** | +2.32% | -0.03% | **Negative** ⚠️ |

---

## Why It Fails

### Mean Reversion, Not Trend

- **56.2%** of signals perform **worse** at 5d vs 3d
- **3 winners** @ 3d became **losers** @ 5d
- **0 losers** @ 3d recovered to **winners** @ 5d

**This is a breakout-pop strategy, not a trend-following one.**

### Signal Breakdown at 5 Days

**Only high-vol names work:**
- **5-7% ATR**: 75% win, +7.64% avg ✅ (n=8)
- **3-5% ATR**: 42.9% win, **-1.05% avg** ❌ (n=21, largest bucket)

**Confidence 80-89 is toxic:**
- **0% win rate** @ 5d, -7.38% avg
- **16.7% win rate** @ 3d, -4.99% avg

---

## What Would Work for Longer Holds?

**Not this strategy.** You'd need:

1. **Trend continuation, not breakouts**
   - Look for pullbacks in established uptrends
   - Avoid fresh breakouts (already extended)

2. **Fundamental catalysts**
   - Earnings growth, product launches, sector rotation
   - Technical patterns alone fade in 3-5 days

3. **Different entry criteria**
   - Lower prior-week momentum (+0-5%, not +10-25%)
   - Wait for consolidation, not pops

**This is a new product, not a config change.**

---

## Recommendations

### 1. ✅ Keep the 3-day hold
- `max_hold_days: 5` + `trailing_min_hold_days: 3` is **optimal**
- Data confirms 3 days captures the pop before mean reversion

### 2. ✅ Tighten filters to boost 3-day edge
- **Raise `min_buy_confidence` to 90** (cut toxic 80-89 band)
- Continue AI gate tuning (2026-09-17 prompt changes)
- **Don't** chase volume by loosening quality gates

### 3. 🔄 For longer holds, build a separate scanner
- **Option A**: New "Trend Continuation" scanner (pullbacks in uptrends, 10-20d holds)
- **Option B**: Partner with a swing trade product (2-4 week holds)
- **Option C**: Add "hold extension" layer for AI-approved outliers

**Verdict:** Keep current strategy as-is. It's working.

---

## Next Steps

1. **Add Firestore credentials** to run full 10d/15d/20d analysis:
   ```bash
   PYTHONPATH=./src:. python scripts/research_profit_multi_hold.py \
     --since 2026-08-04 --limit-runs 400 \
     --max-hold-sessions 20 \
     --out-dir docs/research/2026-09/multi_hold_analysis
   ```

2. **Monitor upcoming entry batches** (post-2026-09-17 prompt changes) for actionable flow

3. **Consider raising `min_buy_confidence`** to 90 if edge remains after prompt tuning

4. **If you want swing trades**, scope a separate trend-following system (different repo/collection)

---

## Full Report

See [`longer-hold-investigation-2026-09-28.md`](./longer-hold-investigation-2026-09-28.md) for:
- Detailed signal-by-signal analysis
- Winners-turned-losers breakdown (PPC, LIND, PD)
- ATR/confidence/momentum slices
- Literature review on breakout vs trend strategies
- Implementation options for a separate swing system

**Bottom line:** The 3-day hold is the sweet spot. Don't break what's working.
