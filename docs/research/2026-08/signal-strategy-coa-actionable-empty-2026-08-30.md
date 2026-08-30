# Course of action — empty actionable book (2026-08-30)

## Verdict

Actionable ledger is empty because **`ai_gate=passed` never happened** (BUY + total≥70 + conviction≥0.7), not because the technical scanner is dead.

Latest UI research run `2026-08-30T20-09-46.791000Z` (since 2026-08-04, all technical BUYs):

| Slice | n | Win% | Avg | PF |
|-------|---|------|-----|-----|
| Overall @ hold (mature) | 22 | 77.3 | +3.11% | 2.36 |
| `ai_gate=passed` | **0** | — | — | — |
| filtered (LLM WAIT) | 9 | 66.7 | +2.17% | 2.08 |
| pending | 6 | 83.3 | +1.88% | 2.71 |
| skipped (`rule_skip`) | 7 | 85.7 | +5.36% | 2.47 |

AI decisions in cohort: **WAIT=16, BUY=0**.

## Why no actionable signals

1. **Top-N starve** — `max_entry_evals_per_run: 3` + `rule_skip` permanently marked continuation winners (LIFE/LBRX) as skipped without LLM.
2. **Latest-doc-only batch** — older `pending` rows never drained.
3. **WAIT-biased prompts** — Prefer WAIT / RSI>70 auto-WAIT vetoed mid-move continuation the research likes.
4. **Model** — `gpt-5.4` chat is correct; `gpt-5.4-pro` must stay empty (Responses-only → 404 → pending). Thresholds 70/0.7 are fine; the LLM never said BUY.

## Strategy vs market (Aug 2026)

Keep hard rejects (conf≥98 / ret_5d≥50 / vol≥5) and continuation band ret_5d∈[10,20] & vol∈[2,3). Breadth is selective; quiet continuation beats lottery/ignition. Do **not** loosen filters for LIFE-style outliers.

## Fixes applied (2026-08-30)

- `config.yaml` `ai.max_entry_evals_per_run`: 3 → **8**
- Entry batch: multi-doc pending drain when no `--signal-doc-id`; **never `rule_skip` continuation-band** (overflow stays pending)
- `prompts/entry/entry_evaluator_system.md` + guardrails: continuation-band prefer BUY when R/R+volume+trend pass

## Do / don't

| Do | Don't |
|----|-------|
| Keep hard rejects + continuation band | Treat pending as actionable |
| `entry_model: gpt-5.4`, `pro_model: ""` | Enable `gpt-5.4-pro` without Responses API |
| Remeasure `--actionable-only` once passed mature n≥5 | Judge product by technical PF alone while passed=0 |
| Confirm OpenAI quota; run entry batch daily | Re-enable ignition / vol≥5 bypass |

## Next measure

```bash
PYTHONPATH=./src:. python -m scripts.ai_stock_eval.main --config config.yaml --batch
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-08-04 --actionable-only \
  --out-csv docs/research/2026-08/profit_hold_cohort_actionable_since_2026-08-04.csv \
  --out-json docs/research/2026-08/profit_hold_cohort_actionable_since_2026-08-04_summary.json
```

Next research due (from run): **2026-09-13**.
