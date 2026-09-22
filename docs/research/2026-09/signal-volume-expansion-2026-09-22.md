# Signal Volume Expansion — Week 1 Implementation — 2026-09-22

**Date:** 2026-09-22  
**Context:** Expand signal generation from ~3 actionable/month to ~4-8 actionable/month while maintaining quality (PF ≥ 1.4)  
**Status:** Week 1 changes implemented, monitoring phase begins  

---

## Executive Summary

Signal starvation diagnosis identified **discovery capacity** and **scanning frequency** as primary bottlenecks, not strategy filters. Since Aug 4, 2026:

- **34 technical BUYs** generated (~1 per trading day)
- **Only 2 `ai_gate=passed`** signals (PD, ROIV) — both losses at raw close
- **32 AI WAIT decisions** — including winners (GTLB +11%, PSNL +9%, LUNR +5.5%)

Research shows continuation strategy (ret_5d 10-20%, vol 2-3x, ATR 5-7%) has **PF 2.02**, but universe is capped at **top 100 symbols/day** and scans run only **~1x/day** due to timing gate failures.

**Week 1 fix**: Expand discovery capacity 2.5x, increase scan frequency 3x, process 50% more AI evals.

---

## Bottleneck Analysis

### 1. Discovery Phase Constraints (Most Critical)

**Before** (universe-discovery-daily.yml):
```bash
--max-calls 2000       # Evaluates 2000 symbols/day
--top-k 100            # Only top 100 marked active ⚠️ PRIMARY BOTTLENECK
--min-confidence 50    # BUY setup score floor
--merge-days 7         # Lookback window
```

**Problem**: Scanning thousands but keeping only 100 active. With 1 signal/day from 100 symbols, you need 2.5x more active symbols to hit target volume.

### 2. GitHub Actions Timing Gate Failures

From Sept 8 research ([signal-starve-diagnosis-2026-09-08.md](./signal-starve-diagnosis-2026-09-08.md)):
- Scheduled: 12:30 UTC & 13:30 UTC
- Gate allows: 08:05-08:55 ET only
- **Actual run times**: 12:45 PM ET, 1:20 PM ET, 2:19 PM ET ❌ gated out

**Impact**: Scans run <50% of scheduled times; signals that form 09:00-13:00 ET missed entirely.

### 3. AI Gate Conservative (Secondary)

Technical BUYs with high scores got WAIT:
- GTLB: 87 total → WAIT (+11.2% hold)
- PSNL: 100 total → WAIT (+9.1% hold)
- LUNR: 92 total → WAIT (+5.5% hold)

Only 2/34 technical BUYs passed AI gate; both lost. AI prompt updates (Sept 17) not yet reflected in live signals.

### 4. Single Daily Scan Window

Premarket scan only; misses:
- Mid-morning breakouts (10:00-11:00 ET)
- Lunch dip recoveries (12:00-13:00 ET)
- Afternoon ignition (14:00-15:00 ET)

---

## Week 1 Implementation (Low Risk, High Impact)

### Change 1: Expand Discovery Universe ✅

**File**: `.github/workflows/universe-discovery-daily.yml`

```diff
- --max-calls 2000
+ --max-calls 3500           # +75% evaluation capacity

- --merge-days 7
+ --merge-days 10             # +3 days lookback for continuity

- --min-confidence 50
+ --min-confidence 45         # -5 points to capture more setups

- --watch-min-confidence 55
+ --watch-min-confidence 50   # Align with min-confidence

- --top-k 100
+ --top-k 250                 # +150% active symbols ⭐ PRIMARY FIX
```

**Expected impact**:
- Active universe: 100 → **250 symbols/day** (+150%)
- Discovery evaluations: 2000 → **3500/day** (+75%)
- Technical BUYs: ~1/day → **~2.5/day**

**Quality risk**: **Low** — min_confidence 45 still filters out weak setups; strategy filters (ret_5d, vol, ATR) unchanged.

### Change 2: Fix Timing Gate + Add Mid-Day Scan ✅

**File**: `.github/workflows/trading-bot-scan.yml`

**A) Add mid-day cron**:
```diff
  schedule:
    - cron: "30 12 * * 1-5"   # 08:30 ET
    - cron: "30 13 * * 1-5"   # 09:30 ET
+   - cron: "30 17 * * 1-5"   # 13:30 ET (new)
```

**B) Widen timing gate**:
```diff
- # Target ~1h before 09:30 ET open → 08:30 local.
- ok = ny.hour == 8 and 5 <= ny.minute <= 55

+ # Allow premarket (08:05-09:15 ET) and mid-day (13:05-13:55 ET) scans.
+ premarket_ok = ny.hour == 8 and 5 <= ny.minute <= 59
+ premarket_extended = ny.hour == 9 and ny.minute <= 15
+ midday_ok = ny.hour == 13 and 5 <= ny.minute <= 55
+ ok = premarket_ok or premarket_extended or midday_ok
```

**Expected impact**:
- Scan frequency: ~0.5x/day (gate failures) → **3x/day** (premarket, open, mid-day)
- Technical BUYs: +100% from intraday breakouts
- Combined with discovery: **~5-7 technical BUYs/day**

**Quality risk**: **None** — same strategy filters, just more observation windows.

### Change 3: Increase AI Entry Batch Capacity ✅

**File**: `config.yaml`

```diff
  ai:
-   max_entry_evals_per_run: 8
+   max_entry_evals_per_run: 12   # +50% AI eval capacity
```

**Expected impact**:
- AI evals: 8 → **12 per batch**
- With 3 scans/day + 1 AI batch/day: process **more pending** backlog
- `ai_gate=passed`: 0.5/month → **~1-2/week**

**Quality risk**: **None** — same thresholds (entry_min_total 70, conviction 0.7); just process more candidates.

---

## Week 1 Expected Outcomes

### Before (Aug 4 - Sep 22)

| Metric | Value |
|--------|-------|
| Active universe | 100 symbols/day |
| Discovery evals | 2000/day |
| Scan frequency | ~0.5x/day (gate failures) |
| Technical BUYs | ~1/day |
| AI evals/batch | 8 |
| `ai_gate=passed` | 0.5/month |

### After Week 1 (Target: Sep 23 - Sep 30)

| Metric | Target | Δ |
|--------|--------|---|
| Active universe | **250 symbols/day** | +150% |
| Discovery evals | **3500/day** | +75% |
| Scan frequency | **3x/day** | +500% |
| Technical BUYs | **5-7/day** | +400-600% |
| AI evals/batch | **12** | +50% |
| `ai_gate=passed` | **~1-2/week** | +300-700% |

**Quality guardrails unchanged**:
- Continuation band: ret_5d [8%, 25%], vol [2.0, 4.0)
- Lottery rejects: ret_5d ≥50% OR vol ≥5x
- ATR: 2-10% (sweet spot 5-7% has PF 7.78)
- Min BUY confidence: 70

---

## Monitoring Plan (Sep 23 - Sep 30)

### Daily Checks

1. **Discovery logs** (Actions → Daily universe discovery):
   - Confirm 3500 evaluations complete
   - Verify 250 active symbols written to Firestore
   - Check `universe_state.json` artifact rotation

2. **Scan logs** (Actions → Premarket trading bot scan):
   - Confirm 3 runs/day (08:30, 09:30, 13:30 ET)
   - Check gate logic allows all 3 windows
   - Count technical BUYs per run

3. **AI entry batch** (Actions → AI entry batch):
   - Verify 12 pending processed per batch
   - Track `ai_gate=passed` count
   - Monitor WAIT vs BUY decisions

### Weekly Cohort (Sep 30)

Run profit-at-hold research for signals since Sep 23:

```bash
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-09-23 --limit-runs 100 \
  --out-csv docs/research/2026-09/profit_hold_week1_all_buys.csv \
  --out-json docs/research/2026-09/profit_hold_week1_all_buys_summary.json

# Actionable only (if n ≥ 5)
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-09-23 --actionable-only --limit-runs 100 \
  --out-csv docs/research/2026-09/profit_hold_week1_actionable.csv \
  --out-json docs/research/2026-09/profit_hold_week1_actionable_summary.json
```

**Success criteria**:
- Technical BUYs: ≥25 (5/day × 5 trading days)
- `ai_gate=passed`: ≥5 (1/day target)
- All BUYs PF: ≥1.3 (allow slight drop from 1.40 baseline)
- Actionable PF: measure once n ≥5 mature

---

## Week 2 Roadmap (Sep 30 - Oct 7)

**Review checkpoint**: Monday, Sep 30, 2026

### If Week 1 hits targets (≥5 actionable, PF ≥1.3):

✅ **Proceed to fine-tuning**:

1. **Lower min_buy_confidence**: 70 → **65**
   - Research shows conf 80-89 is weak (PF 0.08), but 90-94 is strong (PF 1.62)
   - Lowering to 65 allows ranking to work; top signals still conf ≥90

2. **Monitor AI prompt effectiveness**:
   - Sept 17 changes (1.5×ATR stops, continuation features) not yet in live data
   - If AI still WAIT-biased, consider `entry_min_total: 70 → 65`

3. **Consider vol_ratio_min**: 2.0 → **1.8**
   - Research shows 2-3x vol sweet spot, but quieter continuation (1.8-2x) may work
   - **Risk**: Medium — test with single-week cohort first

### If Week 1 underperforms (<3 actionable OR PF <1.2):

⚠️ **Diagnose before advancing**:

1. Check discovery: Are 250 symbols actually reaching the scan?
2. Check scan timing: Are all 3 daily scans running?
3. Check AI gate: Are technical BUYs reaching AI eval, or still rule_skipped?
4. If technical BUYs increased but AI still WAIT → revisit prompt/thresholds

**Do NOT loosen**:
- ❌ Continuation band beyond [8%, 25%] / [2.0, 4.0)
- ❌ Lottery gates (ret_5d ≥50 / vol ≥5)
- ❌ ATR ceiling above 12%

---

## Files Changed (Week 1)

| File | Change | Risk |
|------|--------|------|
| `.github/workflows/universe-discovery-daily.yml` | max-calls 2000→3500, top-k 100→250, min-conf 50→45, merge-days 7→10 | Low |
| `.github/workflows/trading-bot-scan.yml` | Add 13:30 ET cron, widen gate to 08:05-09:15 & 13:05-13:55 | None |
| `config.yaml` | max_entry_evals_per_run 8→12 | None |

---

## Related Research

- [signal-starve-diagnosis-2026-09-08.md](./signal-starve-diagnosis-2026-09-08.md) — Sept 8 continuation band loosening (8% floor)
- [signal-strategy-research-2026-09.md](./signal-strategy-research-2026-09.md) — Sept 17 cohort (n=34, PF 1.40)
- [signal-strategy-coa-actionable-empty-2026-08-30.md](../2026-08/signal-strategy-coa-actionable-empty-2026-08-30.md) — Aug 30 top-N starve fix

---

## Do / Don't

| Do | Don't |
|----|-------|
| Monitor daily: discovery count, scan frequency, AI batch size | Loosen continuation band beyond [8%, 25%] |
| Run weekly cohort Sep 30 (wait for ≥5 mature holds) | Reopen lottery bypass (vol ≥5, ret_5d ≥50) |
| Slack notification Sep 30 for Week 2 review | Lower min_buy_confidence to 65 before seeing Week 1 data |
| Commit with "feat(discovery): expand universe 2.5x + 3 daily scans" | Change strategy filters without cohort measurement |

---

## Commit Message

```
feat(discovery): expand signal capacity 2.5x for volume targets

Week 1 signal volume expansion (low risk, high impact):

Discovery:
- top-k: 100 → 250 symbols/day (+150%)
- max-calls: 2000 → 3500 evals/day (+75%)
- min-confidence: 50 → 45 (capture more setups)
- merge-days: 7 → 10 (longer continuity window)

Scanning:
- Add mid-day scan: 13:30 ET (3rd daily window)
- Widen timing gate: 08:05-09:15 & 13:05-13:55 ET
- Fix gate failures (Sept research: scans gated at wrong times)

AI eval:
- max_entry_evals_per_run: 8 → 12 (+50% capacity)

Expected: 1 technical BUY/day → 5-7/day; 0.5 actionable/month → 1-2/week.
Strategy filters unchanged (continuation PF 2.02 preserved).

Refs: docs/research/2026-09/signal-volume-expansion-2026-09-22.md
```

---

## Next Steps

1. **Commit Week 1 changes** ✅ (this commit)
2. **Deploy to main** → triggers CI + Cloud Run update
3. **Monitor Sep 23-30** — daily discovery/scan logs, weekly cohort
4. **Slack notification Sep 30** — Week 2 review + decision (proceed to fine-tuning or diagnose)
5. **Document Week 2 results** — update this file with actual vs target metrics

---

## Week 2 Notification Trigger

**Date**: Monday, September 30, 2026  
**Channel**: `#trading-signals` (Slack)  
**Message**:

```
🔔 Week 1 Signal Volume Expansion — Review Checkpoint

📊 Run cohort analysis:
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py --since 2026-09-23

📋 Review targets:
- Technical BUYs: ≥25 (target: 5/day)
- ai_gate=passed: ≥5 (target: 1/day)
- All BUYs PF: ≥1.3

✅ If targets met → proceed to Week 2 fine-tuning (see docs/research/2026-09/week2-action-plan.md)
⚠️ If underperforming → diagnose discovery/scan/AI logs before advancing

📖 Full details: docs/research/2026-09/signal-volume-expansion-2026-09-22.md
```
