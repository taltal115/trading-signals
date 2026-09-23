# AI Gate Analysis - SECZ - 2026-09-23

**Date:** 2026-09-23  
**Context:** SECZ up 46% all-time high, but AI gate failed  
**Question:** Why did the AI gate fail, and will yesterday's code change affect it?

---

## Quick Answer

**Yesterday's code change (2026-09-22) will NOT affect whether SECZ passes the AI gate.**

The change only increased `max_entry_evals_per_run` from 8 → 12, meaning MORE signals can be evaluated per run. The actual AI gate thresholds remain unchanged:
- `entry_min_total: 70` (unchanged)
- `entry_min_conviction: 0.7` (unchanged)

---

## How the AI Gate Works

The AI gate is the hard filter that determines whether a technical BUY signal becomes "actionable" (i.e., passed). A signal passes the AI gate when **ALL** of these conditions are met:

### Required Conditions (from `scripts/ai_stock_eval/recommendation.py`):

```python
def resolve_ai_gate(
    *,
    recommendation: dict[str, Any],
    conviction: float,
    entry_min_total: float,
    entry_min_conviction: float,
) -> str:
    decision = str(recommendation.get("decision") or "WAIT").upper()
    total = float((recommendation.get("scores") or {}).get("total") or 0.0)
    detail = recommendation.get("detail") if isinstance(recommendation.get("detail"), dict) else {}
    direction = str(detail.get("direction") or "long").strip().lower()
    
    # Filter short-thesis signals
    if direction.startswith("short"):
        return "filtered"
    
    # Pass when BUY + sufficient scores
    if (
        decision == "BUY"
        and total >= float(entry_min_total)
        and float(conviction) >= float(entry_min_conviction)
    ):
        return "passed"
    
    return "filtered"
```

### The Four Gates:

| Gate | Threshold | Purpose |
|------|-----------|---------|
| **1. Decision = "BUY"** | Exact match | AI must recommend BUY (not WAIT/AVOID) |
| **2. Total score >= 70** | `entry_min_total` | Combined technical + AI score |
| **3. Conviction >= 0.7** | `entry_min_conviction` | AI confidence (0.0 - 1.0 scale) |
| **4. Direction = "long"** | Must not start with "short" | Long-only book |

**If ANY gate fails → `ai_gate=filtered`**

---

## Common Failure Modes

Based on August 2026 research, here are the most common reasons signals fail the AI gate:

### 1. **Low Total Score** (score < 70)
- **Technical score** is too low (breakout/momentum/volume components)
- **AI score** is too low (AI component typically = conviction × 16)
- Even if the AI says "BUY", the combined score may not reach 70

**Example from Sept research:**
- Signal with technical=60, AI component (conviction 0.75 × 16) = 12
- Total = 72 → **PASS** ✅
- Signal with technical=55, AI component (conviction 0.65 × 16) = 10.4  
- Total = 65.4 → **FAIL** ❌

### 2. **Low Conviction** (conviction < 0.7)
- AI is uncertain about the setup
- Common when:
  - Risk/reward ratio < 1.5
  - Conflicting technical signals
  - Overextension concerns
  - Missing catalysts

**Example:**
- AI says "BUY" but conviction = 0.65
- Even with total score = 75
- **FAIL** ❌ (conviction too low)

### 3. **AI Says WAIT or AVOID**
- AI doesn't like the setup despite passing technical filters
- Reasons include:
  - Already overextended
  - Poor risk/reward
  - Weak catalysts
  - Better opportunities elsewhere

**Example from Sept expansion doc:**
- GTLB: technical score 87 → AI said WAIT (but stock went +11%)
- PSNL: technical score 100 → AI said WAIT (but stock went +9%)
- LUNR: technical score 92 → AI said WAIT (but stock went +5.5%)

### 4. **Short-Thesis Signal** (rare)
- AI recommends shorting instead of buying
- Automatically filtered (long-only book)

---

## Why Might SECZ Have Failed?

Without seeing SECZ's actual recommendation data, the most likely reasons are:

### Scenario A: Low Total Score
```
Technical score: 65
AI component (conviction 0.8 × 16): 12.8
Total: 77.8 → PASS ✅

But if technical was lower:
Technical score: 55
AI component (conviction 0.8 × 16): 12.8
Total: 67.8 → FAIL ❌ (total < 70)
```

### Scenario B: Low Conviction
```
Total score: 75
Conviction: 0.65
Decision: BUY
→ FAIL ❌ (conviction < 0.7)
```

### Scenario C: AI Said WAIT
```
Total score: 80
Conviction: 0.85
Decision: WAIT (AI sees overextension risk)
→ FAIL ❌ (decision != BUY)
```

**Most likely for SECZ (up 46% ATH):** AI probably saw overextension signals and said WAIT or had low conviction due to extended move.

---

## Will Yesterday's Change Affect SECZ?

### What Changed (2026-09-22):

**File:** `config.yaml`
```diff
- max_entry_evals_per_run: 8
+ max_entry_evals_per_run: 12  # +50% capacity
```

### Impact Analysis:

| What Changed | Impact on AI Gate |
|--------------|-------------------|
| `max_entry_evals_per_run: 8 → 12` | **No impact on thresholds** |
| `entry_min_total: 70` | **Unchanged** |
| `entry_min_conviction: 0.7` | **Unchanged** |

**Conclusion:** The change only affects **HOW MANY** signals can be evaluated per run, not **WHETHER** they pass the gate.

### What This Means for SECZ:

1. **If SECZ was skipped** (rank #9+ when limit was 8):
   - ✅ NOW it might get evaluated (capacity increased to 12)
   - But it still needs to meet the same thresholds to pass

2. **If SECZ was already evaluated** (rank #1-8):
   - ❌ NO CHANGE - same thresholds apply
   - If it failed with total=68 before, it will still fail with total=68 now

3. **If SECZ is pending** (`ai_gate=pending`):
   - ✅ Higher chance of being evaluated in next run
   - But still needs total≥70, conviction≥0.7, decision=BUY to pass

---

## How to Check SECZ's Actual Data

Run this diagnostic script:

```bash
cd /workspace
python3 scripts/check_signal_ai_gate.py SECZ
```

This will show:
- ✅/❌ status for each gate condition
- Actual total score vs. 70 threshold
- Actual conviction vs. 0.7 threshold  
- AI decision (BUY/WAIT/AVOID)
- AI reasoning ("why" field)
- Full recommendation breakdown

**Example output:**
```
🚦 AI GATE ANALYSIS:
  Status: FILTERED
  
  ✅ PASS: Decision is BUY
  ❌ FAIL: Total score >= 70
      → Score is 68.50, needs 70
  ✅ PASS: Conviction >= 0.7
  ✅ PASS: Direction is long
```

---

## Historical Context (Aug-Sept 2026)

From signal expansion research, AI gate has been conservative:

### August 2026 Results:
- **34 technical BUYs** generated
- **Only 2 ai_gate=passed** (PD, ROIV) — both losses
- **32 AI WAIT decisions** — including winners (GTLB +11%, PSNL +9%, LUNR +5.5%)

### The Paradox:
- Continuation strategy has **PF 2.02** on raw technical BUYs
- But AI gate filtered out many winners
- AI tends to be conservative on extended moves

### Why AI Might Filter Winners:
1. **Overextension bias:** AI sees +46% move, says "too late"
2. **Risk aversion:** High prior momentum = high AI risk score
3. **Missing context:** AI doesn't see tape/momentum continuation
4. **Static snapshot:** AI evaluates at signal time, not continuation

---

## Recommendations

### For SECZ Specifically:

1. **Check actual data first:**
   ```bash
   python3 scripts/check_signal_ai_gate.py SECZ --limit 20
   ```

2. **If filtered due to low score (<70):**
   - Consider if technical scoring is too conservative
   - Review breakout/momentum/volume weights

3. **If filtered due to AI WAIT:**
   - Review AI prompt for overextension bias
   - Check if risk/reward calculation is appropriate for continuation plays

4. **If ai_gate=pending:**
   - It may be evaluated in next run (capacity now 12 vs 8)
   - Monitor if it gets processed

### For Strategy Overall:

The continuation strategy (ret_5d 8-25%, vol 2-4x) shows strong edge (PF 2.02), but AI gate is missing winners. Consider:

1. **Lower entry_min_total:** 70 → 65 (cautious, +10-15% more passed)
2. **Lower entry_min_conviction:** 0.7 → 0.65 (cautious, +5-10% more passed)
3. **Adjust AI prompt:** Reduce overextension penalty for continuation-band signals
4. **Add continuation override:** Auto-pass continuation signals with technical≥75

**Risk:** Lowering thresholds may increase losses. Measure via profit-hold research first.

---

## Next Steps

1. **Check SECZ data:**
   ```bash
   python3 scripts/check_signal_ai_gate.py SECZ
   ```

2. **Review AI reasoning:** Read the "why" field to understand AI decision

3. **Compare to thresholds:** See exact gap between SECZ scores and requirements

4. **Decide on action:**
   - If close miss (score 68-69): Consider lowering threshold
   - If AI overextension: Review prompt for continuation bias
   - If pending: Monitor next run (capacity now higher)

5. **Document finding:** Add to Sept research folder for strategy review

---

## References

- AI gate logic: `scripts/ai_stock_eval/recommendation.py` → `resolve_ai_gate()`
- Config: `config.yaml` → `ai.entry_min_total`, `ai.entry_min_conviction`
- Research: `docs/research/2026-09/signal-volume-expansion-2026-09-22.md`
- Pipeline: `docs/ai-signal-pipeline/README.md`
