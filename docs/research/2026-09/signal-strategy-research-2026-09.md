# Signal strategy research — 2026-09-17

**Analysis date:** 2026-09-17  
**Prior notes:** [`../2026-08/signal-strategy-research-2026-08-followup-post-0804.md`](../2026-08/signal-strategy-research-2026-08-followup-post-0804.md), [`../2026-08/signal-strategy-coa-actionable-empty-2026-08-30.md`](../2026-08/signal-strategy-coa-actionable-empty-2026-08-30.md)

**Question:** Since the Aug-4 hard filters, how did BUY signals do at raw profit @ `hold_days`, and what still blocks **actionable** (`ai_gate=passed`) names that look like the continuation winners?

**Primary metric:** close-to-close return after each signal’s `hold_days` (all mature rows used **3** sessions). Managed stop/target is secondary (`finalized_*`).

---

## Verdict

The technical book since 2026-08-04 is still a **modest winner** (n=34, 61.8% win, +1.11% avg, PF **1.40**). The product ledger is not: only **2** `ai_gate=passed` holds (PD, ROIV), both red at the 3-day close. The scanner is not starved; the entry LLM still WAITs in-band names that later worked (PSNL +9.1%, GTLB +11.2%, SRPT +7.5%). Lottery stays toxic (HYFM −25.6%). Do **not** reopen vol≥5× / ret_5d≥50%.

---

## Cohorts (since 2026-08-04, limit 400 runs)

| Cohort | n mature | Win% | Avg | Median | PF | Sum % |
|--------|----------|------|-----|--------|-----|-------|
| **All technical BUYs** | **34** | **61.8** | **+1.11** | +2.32 | **1.40** | +37.9 |
| **Actionable only** (`passed`) | **2** | **0.0** | **−1.01** | −1.01 | **0.00** | −2.0 |
| `filtered` (LLM WAIT) | 24 | 62.5 | +0.54 | +2.32 | 1.23 | +12.9 |
| `skipped` (`rule_skip`) | 8 | 75.0 | +3.38 | +3.28 | 1.75 | +27.0 |
| AI decision WAIT | 32 | 65.6 | +1.25 | +2.42 | 1.43 | +39.9 |
| AI decision BUY | 2 | 0.0 | −1.01 | −1.01 | 0.00 | −2.0 |

+5 sessions is weaker (n=32, 50% win, +0.26%, PF 1.08) — keep the 3-session hold as the headline.

Loaded **38** unique BUYs; **4** still immature (2026-09-14 INSP/QRVO, 2026-09-16 MYGN/SDGR) — all `filtered`.

### Artifacts

| File | Role |
|------|------|
| [`profit_hold_cohort_all_buys_since_2026-08-04.csv`](./profit_hold_cohort_all_buys_since_2026-08-04.csv) | Mature technical book |
| [`profit_hold_cohort_all_buys_since_2026-08-04_summary.json`](./profit_hold_cohort_all_buys_since_2026-08-04_summary.json) | Headline + slices |
| [`profit_hold_cohort_actionable_since_2026-08-04.csv`](./profit_hold_cohort_actionable_since_2026-08-04.csv) | PD + ROIV |
| [`profit_hold_cohort_all_buys_since_2026-08-04_incl_immature.csv`](./profit_hold_cohort_all_buys_since_2026-08-04_incl_immature.csv) | Gate inventory (38 rows) |

```bash
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-08-04 --limit-runs 400 \
  --out-csv docs/research/2026-09/profit_hold_cohort_all_buys_since_2026-08-04.csv \
  --out-json docs/research/2026-09/profit_hold_cohort_all_buys_since_2026-08-04_summary.json

PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-08-04 --actionable-only --limit-runs 400 \
  --out-csv docs/research/2026-09/profit_hold_cohort_actionable_since_2026-08-04.csv \
  --out-json docs/research/2026-09/profit_hold_cohort_actionable_since_2026-08-04_summary.json
```

---

## 1. What the technical book says

### Keep (confirmed)

| Slice | n | Win% | Avg | PF |
|-------|---|------|-----|-----|
| ret_5d **10–20%** | 30 | 63.3 | +2.01 | **2.02** |
| vol **2–3×** | 31 | 61.3 | +0.79 | 1.36 |
| conf **95–99** | 12 | 75.0 | +3.28 | **3.40** |
| conf **90–94** | 12 | 66.7 | +1.01 | 1.62 |
| ATR **5–7%** | 8 | 75.0 | +8.57 | **7.78** |

Continuation-shaped names (quiet 5-day momentum, 2–3× volume) still carry the edge. ATR 5–7% is the **best** volatility band — the same names the old “never >3% stop” prompt would treat as too wide (scanner stop = 1.5×ATR ≈ 7.5–10.5%).

### Do not reopen

| Slice | n | Win% | Avg | PF | Note |
|-------|---|------|-----|-----|------|
| ret_5d **≥50%** | 1 | 0 | −25.58 | 0 | HYFM |
| vol **≥5×** | 2 | 50 | −12.46 | 0.03 | HYFM + ITGR |
| conf **80–89** | 6 | 16.7 | −4.99 | 0.08 | SNPS, NEO, GPI, NCNO; META +2.5% is the exception |

Lottery hard rejects (`ret_5d≥50`, `vol≥5`) stay. `hard_reject_confidence_min: 0` stays (in-band conf≥98 is ranking-only). Do not treat `pending` as actionable.

### Actionable sample (too small to claim an AI edge)

| asof | ticker | hold% | managed | outcome |
|------|--------|-------|---------|---------|
| 2026-08-30 | PD | −0.43 | **+3.18** | target |
| 2026-09-08 | ROIV | −1.59 | −2.97 | stop |

PD’s managed target is the one “good” paper result; raw 3-day close was still slightly red. n=2 is not a strategy.

---

## 2. Missed good signals vs WAIT that saved losses

Entry LLM scored many continuation names highly and still said **WAIT** (`ai_gate=filtered`).

**Missed winners** (`filtered`, `ai_total≥80`, hold &gt; +3%):

| asof | ticker | hold% | managed | total | ATR% |
|------|--------|-------|---------|-------|------|
| 2026-08-10 | GTLB | +11.2 | +4.7 time | 87 | 5.3 |
| 2026-08-20 | PSNL | +9.1 | **+11.6 target** | 100 | 4.6 |
| 2026-08-14 | LUNR | +5.5 | +10.0 time | 92 | 7.8 |
| 2026-08-20 | PRME | +4.8 | −8.9 stop | 100 | 5.9 |
| 2026-08-13 | MNTN | +4.6 | +4.8 time | 89 | 5.7 |

SRPT (+7.5%, total 75) is the same pattern just under 80.

**WAIT that also avoided ugly names** (`filtered`, `ai_total≥80`, hold &lt; 0): LPTH −14.2 (total 100), MLYS −9.4 (98), GPI −6.3 (96), SGMT −3.5 (100), MGTX −0.3 raw / −6.9 stop (100).

So we **cannot** blindly map `total≥80` → BUY. The model needs the continuation features it was told to use, plus a stop rule that matches the scanner. Showing **ret_10d** (LPTH 46%, SGMT 48%) is the intended brake on near-lottery overextension.

`rule_skip` still hid winners (LIFE +38%, LBRX +12%, STGW +5.4%, OCTV +2.9%) from the Aug-4 top-N starve. Live path now keeps in-band overflow **pending** instead of skip; LIFE vol 3.59 remains **outside** the 3.5× cap on purpose.

---

## 3. Why the ledger is empty (after September scanner knobs)

Already in `config.yaml` (do not unwind):

- `hard_reject_confidence_min: 0`
- Continuation **ret_5d 10–25%**, vol **[2.0, 3.5)**
- Lottery rejects 50 / 5×
- Entry R/R floor **1.5** (aligned with 2.5 / 1.5 ATR ≈ 1.67R)
- `max_entry_evals_per_run: 8`; in-band never `rule_skip`

Remaining starve was the **entry prompt**, not admission:

1. System prompt said stop must be **never >3%**. Continuation ATR is typically 3–7%, so 1.5×ATR is 4.5–10.5%. That fights the best ATR slice (PF 7.78).
2. User template never sent `ret_5d`, `vol_ratio`, or a continuation-band flag, so “prefer BUY in band” could not fire.
3. `list_recent_pending_entry_targets` defaults were still **20% / 3.0×**, so a kwargs-less caller could `rule_skip` the newly admitted lane.

`entry_min_total: 70` is **not** the bind: GTLB 87, PSNL 100, QRVO 97 still WAIT’d.

---

## 4. Changes applied (2026-09-17)

| Change | Where |
|--------|--------|
| Stop = **1.5×ATR** (drop 3% ceiling) | `prompts/entry/entry_evaluator_system.md` |
| User prompt: band flag, ret_5d/10d, vol_ratio, ATR%, scanner stop/target | `prompts/entry/entry_evaluator_user_template.md` + `scripts/ai_stock_eval/features.py` |
| Pending-list defaults **25 / 3.5** | `scripts/ai_stock_eval/firestore_write.py` |

**Not changed:** lottery rejects, `require_continuation_band`, `entry_min_total`, treating `pending` as passed, widening vol toward 5× for LIFE.

P2 (not applied): conf **80–89** is a loser bucket (PF 0.08). Raising `min_buy_confidence` to 90 would cut SNPS/GPI/NEO/NCNO but also META. Leave ranking as-is until the prompt change produces a larger `passed` sample.

---

## 5. Remeasure (after the next live entry batches)

Judge product edge only on **mature `ai_gate=passed`**. Historical WAIT rows will not rewrite themselves.

```bash
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-08-04 --actionable-only --limit-runs 400 \
  --out-csv docs/research/2026-09/profit_hold_cohort_actionable_since_2026-08-04.csv \
  --out-json docs/research/2026-09/profit_hold_cohort_actionable_since_2026-08-04_summary.json
```

Watch INSP (2026-09-14, total 91.5, still WAIT) as a live test of the new prompt once it is deployed to the entry batch.
