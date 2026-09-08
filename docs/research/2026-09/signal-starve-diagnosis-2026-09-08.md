# Signal starve diagnosis and fix — 2026-09-08

**Analysis date:** 2026-09-08  
**Context:** Zero actionable signals (`ai_gate=passed`) for >10 days despite Sept 5 strategy widening  
**Prior changes:** [d9b037d](https://github.com/taltal115/trading-signals/commit/d9b037d) — widened continuation band ret_5d [10%, 20%] → [10%, 25%], vol [2.0, 3.0) → [2.0, 3.5)

---

## Executive summary

**Verdict:** The continuation band was **still too restrictive** after the Sept 5 widening. Market isn't producing breakouts in the [10%, 25%] ret_5d window. Additionally, the GitHub Actions scheduled cron jobs aren't running at the correct times (08:30 ET), causing most scans to be gated out.

**Fix applied:** Lower continuation floor from 10% → **8%** (align with base `ret_5d_min`) and widen vol ceiling from 3.5x → **4.0x**.

| Parameter | Aug 30 | Sept 5 | Sept 8 (this fix) |
|-----------|--------|--------|-------------------|
| `continuation_ret_5d_min_pct` | 10.0 | 10.0 | **8.0** |
| `continuation_ret_5d_max_pct` | 20.0 | 25.0 | 25.0 |
| `continuation_vol_ratio_min` | 2.0 | 2.0 | 2.0 |
| `continuation_vol_ratio_max` | 3.0 | 3.5 | **4.0** |

---

## Evidence

### 1. AI entry batch logs (Sept 8, 17:52 UTC)
```
INFO Batch entry pending=0 llm=0 skip=0 leave_pending_in_band=0 multi_doc=True
INFO No pending tickers
```
**→ Zero technical BUYs** reaching the AI gate for evaluation.

### 2. Bot scan workflow analysis
- Scheduled to run at 12:30 UTC and 13:30 UTC (08:30 ET and 09:30 ET)
- Gate allows runs only between 08:05-08:55 ET
- **Recent runs all gated out** — running at wrong times (12:45 PM ET, 1:20 PM ET, 2:19 PM ET, etc.)
- Last runs that should have passed gate: Sept 4, 7, 8 morning scans
- **Result:** No fresh signals written to Firestore

### 3. Configuration analysis
```yaml
# Post-Sept 5 (d9b037d)
strategy:
  ret_5d_min_pct: 8.0                    # base strategy floor
  ret_5d_max_pct: 25.0                   # overextension ceiling
  require_continuation_band: true
  continuation_ret_5d_min_pct: 10.0      # 🔴 GAP: 2% above base floor
  continuation_ret_5d_max_pct: 25.0
  continuation_vol_ratio_min: 2.0
  continuation_vol_ratio_max: 3.5        # 🔴 Slightly tight vs 4x+ breakouts
```

**Starve mechanism:**
1. Base strategy allows ret_5d ≥ 8% AND ≤ 25%
2. Continuation band **requires** ret_5d ≥ 10% for actionable BUY
3. If market produces breakouts in the 8-10% range → **technical BUY but NOT actionable**
4. If market produces breakouts with vol 3.5-4.0x → **filtered out by continuation band**

### 4. Alternatives considered

| Option | Description | Decision |
|--------|-------------|----------|
| **A. Loosen band (surgical)** | Lower floor to 8%, widen vol to 4x | ✅ **Applied** |
| B. Disable continuation band | Set `require_continuation_band: false` | ❌ Too risky; Aug research showed lottery/ignition still toxic |
| C. Re-enable overextension bypass | Allow high-vol breakouts to exceed 25% | ❌ Defer; Sept 5 already disabled this for safety |

---

## Changes applied (2026-09-08)

### Config (`config.yaml`)
```yaml
strategy:
  continuation_ret_5d_min_pct: 8.0    # was 10.0; align with ret_5d_min_pct
  continuation_ret_5d_max_pct: 25.0   # keep
  continuation_vol_ratio_min: 2.0     # keep
  continuation_vol_ratio_max: 4.0     # was 3.5; exclusive upper bound
```

### Code updates
- `src/signals_bot/config.py`: dataclass defaults → 8.0 / 4.0
- `prompts/entry/entry_evaluator_system.md`: continuation band doc → [8%, 25%] / [2.0, 4.0)
- `scripts/ai_stock_eval/main.py`: fallback defaults → 8.0 / 4.0
- `scripts/research_backfill_pending_entry_ai.py`: fallback defaults → 8.0 / 4.0

---

## Rationale

### Why lower floor to 8%?
- **Align with base strategy:** `ret_5d_min_pct = 8.0` already allows 8% momentum
- **Aug research supports:** Prior research focused on ret_5d 10-20% because that's where winners clustered, but base strategy never had an 8-10% hard reject
- **No lottery risk:** 8% ret_5d + 2x vol is **quiet continuation**, not ignition
- **Market fit:** If current breakouts are in 8-10% range, continuation band shouldn't filter them out

### Why widen vol to 4x?
- **Fresh breakouts:** Aug research showed high-vol names (LIFE: 3.6x vol, +38%) can work when not lottery
- **Overextension bypass is disabled:** Can't rely on bypass to rescue 3.5-4.0x vol breakouts
- **Still safe:** Lottery gate (vol ≥ 5x) remains at 5.0x, so 4.0x ceiling won't reopen ignition channel
- **Market fit:** Continuation can have 3.5-4.0x volume without being lottery

### Why NOT disable continuation band?
- **Aug research clear:** Lottery (vol ≥ 5x / ret_5d ≥ 50%) stays toxic (HYFM: −25.6%)
- **Continuation winners:** 5/5 mature Aug winners were in-band (OWL/LIND/MHK/OCTV/STGW: +2% to +6%)
- **Prefer surgical fix:** Loosen band vs disabling safety rails entirely

---

## Next steps

### 1. Monitor signal generation (immediate)
```bash
# Manual scan to verify BUYs are now generated
cd /workspace
source .venv/bin/activate
PYTHONPATH=./src python -m signals_bot.main --config config.yaml --dry-run
```

Expected: Technical BUYs in ret_5d [8%, 25%] / vol [2.0, 4.0) should now pass continuation band.

### 2. Fix GitHub Actions cron timing (ops)
Investigate why scheduled runs aren't happening at 12:30 UTC / 08:30 ET:
- Check GitHub Actions cron execution logs
- Verify timezone handling in gate logic
- Consider manual trigger or adjust gate window if cron is unreliable

### 3. Remeasure actionable cohort (once signals mature)
```bash
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-09-08 --actionable-only \
  --out-csv docs/research/2026-09/profit_hold_cohort_actionable_since_2026-09-08.csv \
  --out-json docs/research/2026-09/profit_hold_cohort_actionable_since_2026-09-08_summary.json
```

Wait for ≥5-10 mature `ai_gate=passed` holds (3+ sessions each) before judging edge.

### 4. Consider P2: overextension bypass (if starve persists)
If 8-25% band still produces zero signals, consider re-enabling selective bypass:
```yaml
strategy:
  overextension_bypass_vol_ratio: 4.0  # was 0; allow 4x+ vol to bypass 25% ceiling
```

But only if (a) starve continues AND (b) manual scans show 4x+ vol breakouts above 25% ret_5d.

---

## Do / Don't

| Do | Don't |
|----|-------|
| Run manual scan to verify fix | Assume fix worked without testing |
| Monitor `ai_gate=passed` count daily | Judge edge before ≥5 mature holds |
| Fix cron timing so scans run at 08:30 ET | Disable continuation band preemptively |
| Remeasure actionable cohort once mature | Loosen lottery gates (vol≥5 / ret≥50) |

---

## Implementation log

| File | Change |
|------|--------|
| `config.yaml` | continuation_ret_5d_min_pct: 10.0→8.0, continuation_vol_ratio_max: 3.5→4.0 |
| `src/signals_bot/config.py` | Dataclass defaults updated to match |
| `prompts/entry/entry_evaluator_system.md` | Continuation band doc: [10%, 25%]→[8%, 25%], [2.0, 3.5)→[2.0, 4.0) |
| `scripts/ai_stock_eval/main.py` | Fallback defaults: 10.0→8.0, 3.5→4.0 |
| `scripts/research_backfill_pending_entry_ai.py` | Fallback defaults: 10.0→8.0, 3.5→4.0 |

**Commit:** [pending]  
**Deployed:** [pending — manual scan + CI deploy after commit]

---

## Related research

- [signal-strategy-coa-actionable-empty-2026-08-30.md](../2026-08/signal-strategy-coa-actionable-empty-2026-08-30.md) — Aug 30 diagnosis (0 actionable, max_entry_evals_per_run starve)
- [signal-strategy-research-2026-08-followup-post-0804.md](../2026-08/signal-strategy-research-2026-08-followup-post-0804.md) — Aug 10 cohort (lottery toxic, continuation winners)
- Commit [d9b037d](https://github.com/taltal115/trading-signals/commit/d9b037d) — Sept 5 widening (10-20 → 10-25, vol 3.0 → 3.5)
