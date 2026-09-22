# Week 2 Action Plan — Signal Volume Fine-Tuning — 2026-09-30

**Review Date:** Monday, September 30, 2026  
**Prerequisite:** Week 1 cohort analysis (since 2026-09-23)  
**Decision Framework:** Proceed to fine-tuning OR diagnose issues based on Week 1 results  

---

## Review Checkpoint: Monday, Sep 30, 2026

### Step 1: Run Week 1 Cohort Analysis

```bash
# Navigate to repo
cd /workspace

# Activate venv
source .venv/bin/activate

# All technical BUYs since Week 1 start
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-09-23 --limit-runs 100 \
  --out-csv docs/research/2026-09/profit_hold_week1_all_buys.csv \
  --out-json docs/research/2026-09/profit_hold_week1_all_buys_summary.json

# Actionable only (if n ≥ 5 mature)
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-09-23 --actionable-only --limit-runs 100 \
  --out-csv docs/research/2026-09/profit_hold_week1_actionable.csv \
  --out-json docs/research/2026-09/profit_hold_week1_actionable_summary.json
```

### Step 2: Review Success Criteria

| Metric | Target | Measured | ✅/❌ |
|--------|--------|----------|-------|
| **Technical BUYs** | ≥25 (5/day × 5 days) | _TBD_ | |
| **`ai_gate=passed`** | ≥5 (1/day target) | _TBD_ | |
| **All BUYs PF** | ≥1.3 | _TBD_ | |
| **Actionable PF** | ≥1.4 (if n ≥5) | _TBD_ | |
| **Discovery active** | ~250 symbols/day | _TBD_ | |
| **Scan frequency** | 3 runs/day | _TBD_ | |

### Step 3: Check Operational Metrics

**Discovery logs** (GitHub Actions → Daily universe discovery):
```bash
# Check recent runs
gh run list --workflow=universe-discovery-daily.yml --limit 7

# View latest run
gh run view --log

# Verify: "active_symbols: 250" in Firestore universe/{date} docs
```

**Scan logs** (GitHub Actions → Premarket trading bot scan):
```bash
# Check recent runs (should see ~3/day)
gh run list --workflow=trading-bot-scan.yml --limit 21

# Verify gate logic passed
gh run view {run_id} --log | grep "gate_ok=true"
```

**AI entry batch logs**:
```bash
# Check processed count
gh run list --workflow=ai-entry-batch.yml --limit 7
gh run view --log | grep "pending="
```

---

## Path A: Week 1 Success (≥3 Criteria Met)

**If**: Technical BUYs ≥20 AND (ai_gate=passed ≥5 OR all PF ≥1.3)

### Week 2 Changes: Fine-Tuning (Medium Risk)

#### Change 1: Lower Min BUY Confidence

**File**: `config.yaml`

```diff
  strategy:
-   min_buy_confidence: 70
+   min_buy_confidence: 65   # Allow ranking to work; top signals still conf ≥90
```

**Rationale**:
- Research shows conf **90-94 has PF 1.62**, conf **95-99 has PF 3.40**
- Conf **80-89 is weak (PF 0.08)**, but lowering to 65 lets good signals through
- Ranking soft-penalizes conf ≥98 and prefers 90-94 band
- Floor of 65 ensures minimum setup quality

**Expected impact**: +15-25% technical BUYs (capture conf 65-69 when other features strong)

**Quality risk**: **Medium** — conf 65-69 is unproven. Monitor Week 2 cohort closely.

#### Change 2: Monitor AI Prompt Effectiveness

**If AI still WAIT-biased** (e.g., <40% of technical BUYs pass):

**Option A** — Lower AI entry threshold:
```diff
  ai:
-   entry_min_total: 70
+   entry_min_total: 65
```

**Option B** — Review AI decisions for WAIT with high total:
- Filter Week 1 CSV for `ai_gate=filtered` AND `ai_total ≥80`
- If these are winners (hold% >0), AI prompt still too conservative
- Consider revising `prompts/entry/entry_evaluator_system.md` continuation language

#### Change 3 (Optional): Test Quieter Vol Ratio

**Only if**: Week 1 shows technical BUYs cluster at vol 2.0-2.2x and perform well

```diff
  strategy:
-   vol_ratio_min: 2.0
+   vol_ratio_min: 1.8   # Capture quieter continuation
```

**Rationale**: Research shows 2-3x vol sweet spot, but 1.8-2x might work for low-ATR names.

**Quality risk**: **Medium** — unproven. Run single-week cohort before committing.

---

## Path B: Week 1 Partial Success (1-2 Criteria Met)

**If**: Technical BUYs ≥20 BUT ai_gate=passed <3 AND PF <1.3

### Diagnosis Steps

1. **AI gate analysis**:
   - Check Week 1 CSV: How many technical BUYs reached AI eval?
   - Filter `ai_gate=filtered`, `ai_total ≥75`: Are these winners or losers?
   - If winners → AI too conservative (lower `entry_min_total` or revise prompt)
   - If losers → AI correctly filtering (keep thresholds)

2. **Strategy filter check**:
   - Slice Week 1 by ret_5d band: Is 8-25% producing quality?
   - Slice by vol_ratio: Is 2-4x still the sweet spot?
   - If yes → keep filters; if no → investigate market regime change

3. **Hold period analysis**:
   - Compare ret_3d vs ret_5d: Is 3-day hold still optimal?
   - Check `finalized_outcome` distribution: stop / target / time ratios

### Week 2 Actions (Diagnostic)

- **Do NOT** loosen strategy filters yet
- **Do** lower `entry_min_total` to 65 if AI is blocking winners
- **Do** run daily cohorts (since Sep 23) to track edge evolution
- **Do** post findings in `#trading-signals` for review

---

## Path C: Week 1 Failure (<1 Criterion Met)

**If**: Technical BUYs <20 OR (ai_gate=passed <2 AND PF <1.2)

### Root Cause Analysis

1. **Discovery not running?**
   - Check Actions logs: Are `universe-discovery-daily` jobs succeeding?
   - Check Firestore `universe/{date}`: Are 250 active symbols written?
   - Check `universe_state.json` artifact: Is rotation working?

2. **Scans not running?**
   - Check Actions logs: Are 3 scans/day executing?
   - Check gate logic: Are 08:30, 09:30, 13:30 runs passing gate?
   - If not → timing issue; widen gate further or remove entirely

3. **Discovery evaluating but not producing BUYs?**
   - Review `update_universe_finnhub.py` logs: How many BUYs vs WAITs?
   - Check `min_confidence: 45`: Are symbols scoring ≥45 but failing strategy filters?
   - Check Finnhub API: Quota issues or rate limits?

4. **Market regime change?**
   - Check SPY/QQQ: Is market flat/down (fewer breakouts)?
   - Check VIX: Is volatility low (fewer ATR ≥2% names)?
   - If yes → signal drought may be market-driven, not config

### Week 2 Actions (Emergency)

- **Rollback** Week 1 changes if discovery/scans are broken
- **Fix** operational issues (API limits, timing gates, Firestore writes)
- **Do NOT** proceed to fine-tuning until Week 1 targets hit
- **Do** post incident report in `#trading-signals`

---

## Week 2 Commit Template

**If proceeding to fine-tuning (Path A)**:

```
feat(strategy): lower min confidence 70→65 for broader coverage

Week 2 signal volume fine-tuning (medium risk):

Strategy:
- min_buy_confidence: 70 → 65
- Rationale: conf 90-94 has PF 1.62; lowering floor allows ranking to surface
  strong signals with conf 65-69 when ret_5d/vol/ATR are optimal

AI:
- entry_min_total: 70 → 65 (optional, only if AI WAIT-biased in Week 1)
- Rationale: Sept 17 prompt changes not yet reflected; AI may still over-WAIT

Expected: +15-25% technical BUYs; maintain PF ≥1.3.

Week 1 results (Sep 23-30):
- Technical BUYs: {n} (target ≥25)
- ai_gate=passed: {n} (target ≥5)
- All BUYs PF: {pf} (target ≥1.3)

Refs: docs/research/2026-09/week2-action-plan.md
```

**If diagnosing (Path B/C)**:

```
docs(research): Week 1 expansion results + Week 2 diagnosis

Week 1 results (Sep 23-30):
- Technical BUYs: {n} (target ≥25) {✅/❌}
- ai_gate=passed: {n} (target ≥5) {✅/❌}
- All BUYs PF: {pf} (target ≥1.3) {✅/❌}

Root cause analysis:
- {Finding 1}
- {Finding 2}
- {Finding 3}

Week 2 plan: {diagnostic actions or rollback}

Refs: docs/research/2026-09/week2-action-plan.md
```

---

## Monitoring Plan (Week 2: Sep 30 - Oct 7)

### Daily Checks (Same as Week 1)

1. Discovery logs → verify 250 active
2. Scan logs → verify 3 runs/day
3. AI batch logs → verify 12 evals/batch

### Weekly Cohort (Oct 7)

```bash
# Week 2 cohort (if fine-tuning applied)
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-09-30 --limit-runs 100 \
  --out-csv docs/research/2026-10/profit_hold_week2_all_buys.csv \
  --out-json docs/research/2026-10/profit_hold_week2_all_buys_summary.json

# Actionable only
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-09-30 --actionable-only --limit-runs 100 \
  --out-csv docs/research/2026-10/profit_hold_week2_actionable.csv \
  --out-json docs/research/2026-10/profit_hold_week2_actionable_summary.json
```

**Success criteria (if Path A fine-tuning)**:
- Technical BUYs: ≥30 (6/day × 5 days, +20% from Week 1)
- `ai_gate=passed`: ≥6 (continue 1+/day)
- All BUYs PF: ≥1.3 (maintain quality)
- Conf 65-69 PF: ≥1.2 (new band must not drag down average)

---

## Do / Don't (Week 2)

| Do | Don't |
|----|-------|
| **Path A**: Lower min_buy_confidence to 65 if Week 1 successful | Lower min_buy_confidence without Week 1 cohort |
| **Path A**: Lower entry_min_total to 65 if AI WAIT-biased | Loosen continuation band beyond [8%, 25%] |
| **Path B/C**: Diagnose before fine-tuning | Proceed to Path A if <1 criterion met |
| **Path C**: Rollback if discovery/scans broken | Add more changes without fixing root cause |
| Run weekly cohort Oct 7 (wait ≥5 mature) | Judge quality before mature holds available |

---

## Next Review: Monday, October 7, 2026

**Checkpoint**: Week 2 cohort analysis + decision on Week 3

**Options**:
- ✅ **If PF maintained (≥1.3)**: Continue current config, monitor 2 more weeks for stability
- ⚠️ **If PF degraded (<1.3)**: Rollback Week 2 changes (revert to Week 1 config)
- 🔄 **If signals still low (<4 actionable/week)**: Re-diagnose AI gate or consider market regime

---

## Related Files

- [signal-volume-expansion-2026-09-22.md](./signal-volume-expansion-2026-09-22.md) — Week 1 implementation
- [signal-strategy-research-2026-09.md](./signal-strategy-research-2026-09.md) — Baseline cohort (PF 1.40)
- `config.yaml` — Strategy filters
- `.github/workflows/universe-discovery-daily.yml` — Discovery config
- `.github/workflows/trading-bot-scan.yml` — Scan schedule
