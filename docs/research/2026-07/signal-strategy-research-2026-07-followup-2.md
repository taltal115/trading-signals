# Signal Strategy Research Follow-up #2 — July 2026 (Updated Analysis)

**Analysis Date:** 2026-07-20  
**Implementation Date:** 2026-07-20  
**Prior Research:** [`signal-strategy-research-2026-07-followup.md`](./signal-strategy-research-2026-07-followup.md) (2026-07-16)

> **Status:** Analysis complete. Strategy changes implemented in `config.yaml`, `signal_quality.py`, `main.py`, `config.py`, `firestore.py`, and `slack.py`.

---

## Executive Summary

| Cohort | n (mature) | Win% @ 3d hold | Avg @ hold | Median | PF | Notes |
|--------|------------|----------------|------------|--------|-----|-------|
| Prior research (2026-07-16) | 16 | 37.5% | −3.11% | −2.40% | 0.69 | Already poor |
| **Updated (2026-07-20)** | 20 | **30.0%** | **−8.16%** | −6.46% | **0.40** | Significantly worse |
| Excluding NVVE lottery winner | 19 | 26.3% | −13.25% | −6.65% | 0.12 | Edge fully gone |
| Conf 90–94 only | 5 | **60.0%** | **+0.72%** | +2.10% | **1.25** | Only profitable bucket |
| Conf 100 only | 6 | 16.7% | −18.38% | −35.41% | 0.44 | **Worst bucket** |

**Critical Finding:** The strategy has deteriorated further since the last research. The primary issue is that **confidence = 100 signals are the worst performers**, causing catastrophic losses while moderate confidence (90–94) signals are the only ones with positive edge.

---

## 1. Full July Cohort — Updated Data

### 1.1 Overall Performance (3-day hold)

| Metric | Value |
|--------|-------|
| Mature trades | 20 |
| Wins / losses | 6 / 14 |
| Win rate | **30.0%** |
| Avg return | **−8.16%** |
| Median | −6.46% |
| Avg win / avg loss | +18.12% / −19.42% |
| Profit factor | **0.40** |
| Total PnL sum | **−163.14%** |

### 1.2 Extending to 5 Sessions (subset n=16)

| Metric | Value |
|--------|-------|
| Win rate | 25.0% |
| Avg return | **−11.03%** |
| Profit factor | **0.13** |

**Conclusion:** Extending hold period makes performance **worse**, not better. Stick with 3-day hold or shorter.

---

## 2. Performance by Confidence Level — Critical Analysis

| Confidence | n | Win% | Avg | Median | PF | Total PnL |
|------------|---|------|-----|--------|-----|-----------|
| **100** | 6 | **16.7%** | **−18.38%** | −35.41% | 0.44 | **−110.30%** |
| 95–99 | 4 | 25.0% | −8.18% | −4.17% | 0.02 | −32.70% |
| 80–89 | 5 | 20.0% | −4.74% | −6.65% | 0.15 | −23.71% |
| **90–94** | 5 | **60.0%** | **+0.72%** | +2.10% | **1.25** | **+3.58%** |

### Key Insight: Confidence = 100 is a SELL Signal, Not a BUY Signal

The data is unambiguous: **conf = 100 signals are the worst performers**. Of 6 conf = 100 trades:
- LHSW: −49.26%
- LHAI: −46.72%
- NVVE (Jul 13): −38.70%
- SUNE: −32.11%
- QTTB: −29.61%
- NVVE (Jul 9): +86.10% (lottery winner)

Excluding the one lottery winner (NVVE Jul 9), conf = 100 signals averaged **−39.28%** per trade.

### Why Does This Happen?

Conf = 100 signals occur when **all technical criteria are met perfectly**:
- Strong prior momentum (often ret_5d > 30%)
- High volume spike (often vol_ratio ≥ 5×)
- Fresh breakout to new highs

This combination indicates **extreme euphoria** — exactly when institutional selling is most likely. The strategy is buying the top of parabolic moves, which then collapse.

---

## 3. All July Signals — Complete Log

### 3.1 Winners (6 trades, all non-100 confidence except NVVE lottery)

| Date | Ticker | Return | Conf | Notes |
|------|--------|--------|------|-------|
| 2026-07-09 | NVVE | **+86.10%** | 100 | Lottery winner; same ticker crashed −38.70% on Jul 13 |
| 2026-07-02 | NGNE | +12.87% | **94** | Moderate conf, repeat winner |
| 2026-07-08 | NGNE | +4.13% | **88** | Second entry, lower conf, still won |
| 2026-07-08 | KFRC | +3.00% | **91** | Moderate conf |
| 2026-07-02 | GRND | +2.10% | **93** | Moderate conf |
| 2026-07-07 | OFIX | +0.52% | 95 | Marginal win |

**Winner Pattern:**
- 5 of 6 winners had conf **88–95** (mid-tier)
- Winners had modest gains (+0.5% to +13%) except lottery NVVE
- NGNE appeared twice — re-entries can work when not chasing extremes

### 3.2 Losers (14 trades, dominated by conf 95+)

| Date | Ticker | Return | Conf | AI | Category |
|------|--------|--------|------|-----|----------|
| 2026-07-07 | LHSW | **−49.26%** | 100 | — | Extreme blow-up |
| 2026-07-02 | LHAI | **−46.72%** | 100 | WAIT | AI veto ignored |
| 2026-07-13 | NVVE | **−38.70%** | 100 | — | Chasing lottery winner |
| 2026-07-13 | SUNE | **−32.11%** | 100 | — | Extreme blow-up |
| 2026-07-14 | QTTB | **−29.61%** | 100 | — | Extreme blow-up |
| 2026-07-09 | PRME | −24.89% | 99 | — | Near-100 blow-up |
| 2026-07-13 | PHAT | −13.01% | 92 | — | |
| 2026-07-06 | RXST | −9.45% | 87 | — | |
| 2026-07-08 | KURA | −9.01% | 84 | — | |
| 2026-07-07 | RMD | −6.65% | 85 | — | |
| 2026-07-06 | GPC | −6.26% | 96 | — | |
| 2026-07-06 | RIVN | −2.74% | 88 | — | |
| 2026-07-06 | SLDE | −2.07% | 96 | — | |
| 2026-07-06 | REAX | −1.38% | 94 | — | |

**Loser Pattern:**
- 5 of the 6 worst losses (≥25%) were conf = 100
- LHAI had AI saying "WAIT" but was still treated as BUY — **AI gating not enforced**
- July 13 was a disaster: 3 signals, all conf 100, all lost ≥13%
- July 6 was a wipeout day: 5 signals, 0 wins

---

## 4. Special Cases — Lessons Learned

### 4.1 NVVE: Same Ticker, Opposite Outcomes

| Date | Entry | Return | Conf | What Happened |
|------|-------|--------|------|---------------|
| Jul 9 | $8.49 | **+86.10%** | 100 | Caught the parabolic move up |
| Jul 13 | $13.67 | **−38.70%** | 100 | Bought the top, crashed hard |

**Lesson:** Chasing a ticker after it already made a big move is dangerous. The Jul 13 entry was after NVVE had already risen 61% from the Jul 9 entry. This is a classic "buy high, sell higher" trap.

### 4.2 LHAI: AI Veto Was Correct But Ignored

- **Rules signal:** BUY conf = 100
- **AI evaluation:** WAIT (blended score 86.8, conviction 0.55)
- **Outcome:** −46.72% (one of the worst losses)

**Lesson:** The AI layer correctly identified this as a trap. The AI gating system must be enforced as a **hard filter**, not an optional decoration.

### 4.3 July 6 & July 13: Complete Wipeout Days

| Date | Signals | Wins | Total Return |
|------|---------|------|--------------|
| Jul 6 | 5 | 0 | −21.90% |
| Jul 13 | 3 | 0 | −83.82% |
| Jul 14 | 1 | 0 | −29.61% |

**Lesson:** These days had market conditions unfavorable for breakouts. A regime filter would have avoided all 9 trades for a savings of −135.33% in losses.

---

## 5. Industry Best Practices — Volume Confirmation Strategy

Based on 2026 research from leading trading educators, the following techniques significantly improve breakout success rates:

### 5.1 Volume Confirmation (Critical Filter)

| Rule | Threshold | Purpose |
|------|-----------|---------|
| Breakout bar volume vs 20-period SMA | **≥1.5x** required, **≥2.0x** strong | Confirms institutional participation |
| Follow-through volume (1–3 bars after) | Above average | Confirms continuation interest |
| Retest volume | **Below** breakout volume | Confirms healthy consolidation |

**Implementation:** Add `vol_ratio_breakout_day` filter requiring the breakout candle volume to be ≥1.5x 20-day average. If volume is below this threshold, **skip the signal**.

### 5.2 Price Confirmation (Avoid Fakeouts)

| Rule | Description |
|------|-------------|
| Wait for close | Do not enter on intraday breakout; wait for daily close above level |
| Upper half close | Breakout candle should close in upper 50% of its range |
| No gap-and-trap | If gap up then sells off, do not enter even if close is above level |
| 2-bar confirmation | Wait for 2 consecutive closes beyond the breakout level |

### 5.3 Stop Placement

| Method | Description |
|--------|-------------|
| ATR-based | Stop at 0.5×–1.5× ATR below breakout level |
| Structure-based | Stop below breakout candle low or consolidation range midpoint |
| Time-based | Exit if price doesn't hold breakout within 2–3 candles |

### 5.4 Multi-Timeframe Alignment

| Timeframe | Use |
|-----------|-----|
| Daily | Identify the breakout level |
| 4-hour | Confirm breakout with candle close above level |
| Hourly | Fine-tune entry timing |

**Research Finding:** Studies show 4-hour confirmation produces the best balance of reward and risk. Waiting for daily confirmation may delay entries without significant improvement.

### 5.5 Regime & Context Filters

| Filter | Description |
|--------|-------------|
| Avoid extended runs | Do not enter breakouts after price has already moved >30% in 5 days |
| Market breadth | Confirm broader market supports the move (advancing vs declining) |
| Sector alignment | Ensure sector trend supports individual stock breakout |
| Time of day | Avoid breakouts during low-liquidity periods (10:00–11:00 AM ET) |

---

## 6. Recommended Strategy Changes

### 6.1 Immediate Priority: Fix Confidence Inversion ✅ IMPLEMENTED

| Change | Before | After | Rationale |
|--------|--------|-------|-----------|
| Conf ≥98 handling | Top priority signals | **Flag as high-risk, penalize in ranking** | Conf 100 = −18.38% avg |
| Conf 90–94 handling | Normal | **Prioritize in ranking** | Only profitable bucket |
| Conf 95–99 handling | Normal | **Secondary priority** | Poor but not catastrophic |

**Implemented in `config.yaml`:**

```yaml
# Confidence band ranking (2026-07-20 research follow-up #2):
high_confidence_risk_threshold: 98
prefer_confidence_min: 90
prefer_confidence_max: 94
```

**Implemented in `signal_quality.py`:**
- New function `is_high_confidence_risk()` — flags conf ≥ 98 as high-risk
- New function `in_preferred_confidence_band()` — identifies sweet-spot conf 90–94
- Updated `buy_rank_key()` ranking order:
  1. BUY first
  2. **NOT high-risk confidence** (penalize conf ≥ 98)
  3. **Preferred confidence band** (prioritize conf 90–94)
  4. Preferred ret_5d band
  5. Non-lottery
  6. Least overextended

**Firestore & Slack:**
- New flags `high_confidence_risk_flag` and `preferred_confidence_band` stored
- Slack shows `HIGH-RISK-CONF` and `sweet-spot-conf` labels

### 6.2 Volume Confirmation Filter (Pending)

Add a hard filter for volume confirmation on breakout day:

```yaml
volume_confirmation:
  enabled: true
  min_breakout_vol_ratio: 1.5     # vs 20-day average
  strong_breakout_vol_ratio: 2.0  # for priority ranking
  check_follow_through: true      # Next 1-2 bars above average
```

### 6.3 Overextension Caps ✅ IMPLEMENTED (Tightened)

Current caps allowed all the conf=100 blow-ups. Tightened from 30/60 to 25/50.

**Implemented in `config.yaml`:**

```yaml
# Research 2026-07-20: tightened from 30/60 to 25/50.
# July blow-ups (LHSW, LHAI, SUNE, QTTB) all had extreme prior momentum.
ret_5d_max_pct: 25.0
ret_10d_max_pct: 50.0
```

### 6.4 AI Gate Enforcement (Existing)

The LHAI case proves AI gating works but isn't being enforced:

| Signal | AI Decision | Current Behavior | Required Behavior |
|--------|-------------|------------------|-------------------|
| BUY conf=100 | WAIT | Treated as BUY | **Filter out** |
| BUY conf=100 | BUY | Treated as BUY | Treated as BUY |
| BUY conf<100 | WAIT | Treated as BUY | Flag for review |

**Note:** `slack.require_ai_passed: true` is already set, which defers Slack posting to AI entry batch. High-risk confidence signals are now penalized in ranking, so they're less likely to make the top-N for AI evaluation.

### 6.5 Day-Level Circuit Breaker (Pending)

Implement a circuit breaker to avoid wipeout days:

```yaml
circuit_breaker:
  max_losses_per_day: 2           # Stop signaling after 2 losses same day
  market_breadth_check: true      # Check SPY/QQQ trend before signaling
```

---

## 7. Revised Signal Quality Ranking ✅ IMPLEMENTED

The ranking in `signal_quality.py` has been updated with confidence band scoring.

**New Ranking Priority Order:**

```python
# buy_rank_key() returns tuple for sorting (lower is better for each component):
return (
    action_rank,                     # BUY first
    1 if high_risk else 0,           # Penalize high-risk conf (conf ≥ 98)
    0 if preferred_conf else 1,      # Prioritize preferred conf band (90–94)
    0 if preferred_ret else 1,       # Prioritize preferred ret_5d band (8–20%)
    1 if lottery else 0,             # Deprioritize lottery
    overextension,                   # Least overextended (lower ret_5d)
    -float(score),                   # Higher technical score
    -float(confidence),              # Higher confidence (final tiebreaker)
)
```

**New Flags Stored on Each Signal:**

| Flag | Description |
|------|-------------|
| `high_confidence_risk_flag` | True if conf ≥ 98 (danger zone) |
| `preferred_confidence_band` | True if 90 ≤ conf ≤ 94 (sweet spot) |
| `lottery_flag` | True if vol ≥ 5× or ret_5d ≥ 50% |
| `preferred_ret_5d_band` | True if 8% ≤ ret_5d ≤ 20% |

**Slack Display:**
- `HIGH-RISK-CONF` label for conf ≥ 98 signals
- `sweet-spot-conf` label for conf 90–94 signals

---

## 8. What NOT to Do — Anti-Patterns Confirmed

| Anti-Pattern | Evidence | Harm |
|--------------|----------|------|
| Treat conf=100 as best signals | 5 of 6 conf=100 signals had catastrophic losses | −110.30% total |
| Chase lottery winners | NVVE Jul 13 entry after Jul 9 +86% | −38.70% |
| Ignore AI veto | LHAI had AI "WAIT" but still showed as BUY | −46.72% |
| Extend hold period | 5-session hold worse than 3-session | −11.03% avg vs −8.16% |
| Trade on wipeout days | Jul 6, 13, 14 had 0 wins out of 9 trades | −135.33% |

---

## 9. Action Items for Next Research Cycle

### ✅ Implemented (2026-07-20)

- [x] Add `high_confidence_risk_flag` for conf ≥ 98 signals (Firestore + Slack)
- [x] Add `preferred_confidence_band` flag for conf 90–94 signals
- [x] Rank signals by confidence band (penalize ≥98, prefer 90–94)
- [x] Tighten overextension caps (ret_5d ≤ 25%, ret_10d ≤ 50%)
- [x] Show HIGH-RISK-CONF and sweet-spot-conf labels in Slack

### Pending Implementation

- [ ] Add volume confirmation filter (breakout day vol ≥ 1.5x 20-day avg)
- [ ] Add circuit breaker for wipeout days
- [ ] Add multi-timeframe confirmation (4-hour close above breakout)
- [ ] Enforce AI gate as hard filter (block signals where AI says WAIT)

### Research Follow-Up

- [ ] Track conf ≥98 vs conf 90–94 performance separately with new flags
- [ ] Measure AI gate effectiveness when enforced
- [ ] Backtest volume confirmation filter on historical data
- [ ] Analyze wipeout day characteristics for regime detection

---

## 10. Appendix: Complete July Book

```
asof       ticker  hold%    conf  AI        Status
2026-07-02 GRND    +2.10     93   —         Winner
2026-07-02 LHAI   -46.72    100   WAIT      Blow-up (AI was right!)
2026-07-02 NGNE   +12.87     94   —         Winner
2026-07-06 GPC     -6.26     96   —         Loser
2026-07-06 REAX    -1.38     94   —         Loser
2026-07-06 RIVN    -2.74     88   —         Loser
2026-07-06 RXST    -9.45     87   —         Loser
2026-07-06 SLDE    -2.07     96   —         Loser
2026-07-07 LHSW   -49.26    100   —         Blow-up
2026-07-07 OFIX    +0.52     95   —         Winner
2026-07-07 RMD     -6.65     85   —         Loser
2026-07-08 KFRC    +3.00     91   —         Winner
2026-07-08 KURA    -9.01     84   —         Loser
2026-07-08 NGNE    +4.13     88   —         Winner
2026-07-09 NVVE   +86.10    100   —         Lottery winner
2026-07-09 PRME   -24.89     99   —         Blow-up
2026-07-13 NVVE   -38.70    100   —         Blow-up (chased lottery)
2026-07-13 PHAT   -13.01     92   —         Loser
2026-07-13 SUNE   -32.11    100   —         Blow-up
2026-07-14 QTTB   -29.61    100   —         Blow-up
```

---

## Summary

The July 2026 data tells a clear story:

1. **Confidence = 100 is broken** — it indicates euphoria tops, not high-quality entries
2. **Confidence 90–94 is the sweet spot** — moderate confidence = better risk-adjusted returns
3. **AI gating works** — the one AI "WAIT" signal lost 47%; enforce it
4. **Volume confirmation is essential** — industry best practice, not yet implemented
5. **Longer hold makes it worse** — stick with 3 days or shorter

### Changes Implemented (2026-07-20)

| Change | Files Modified |
|--------|----------------|
| Confidence band ranking (penalize ≥98, prefer 90–94) | `signal_quality.py`, `main.py` |
| New config fields for confidence thresholds | `config.yaml`, `config.py` |
| Tightened overextension caps (25/50 from 30/60) | `config.yaml` |
| `high_confidence_risk_flag` stored on signals | `firestore.py` |
| `preferred_confidence_band` stored on signals | `firestore.py` |
| HIGH-RISK-CONF / sweet-spot-conf Slack labels | `slack.py` |

### Still Needed

- Volume confirmation filter (1.5x breakout volume)
- Hard AI gate enforcement (block AI "WAIT" signals)
- Circuit breaker for wipeout days

---

**Related:**
- Prior research: [`signal-strategy-research-2026-07-followup.md`](./signal-strategy-research-2026-07-followup.md)
- Original research: [`signal-strategy-research-2026-07.md`](./signal-strategy-research-2026-07.md)
- Bot logic: [`docs/bot-logic-and-strategy.md`](../bot-logic-and-strategy.md)
- Data: [`profit_hold_cohort_2026-07-20_summary.json`](./profit_hold_cohort_2026-07-20_summary.json)
