---
name: signal-research
description: Run and interpret profit-at-hold cohort research for BUY signals. Use when measuring win rate, avg return, or profit factor; comparing actionable vs all BUYs; or documenting strategy findings under docs/research/.
---

# Signal research (profit @ hold)

## When to use

- “Did BUYs make money?” / cohort since a date
- Actionable-only (`ai_gate=passed`) vs full technical BUY set
- Writing notes under `docs/research/YYYY-MM/`

## Run cohort

From repo root (venv activated, `PYTHONPATH` includes `src`):

```bash
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since YYYY-MM-DD \
  --actionable-only \
  --out-csv docs/research/YYYY-MM/profit_hold_cohort_actionable_since_YYYY-MM-DD.csv \
  --out-json docs/research/YYYY-MM/profit_hold_cohort_actionable_since_YYYY-MM-DD_summary.json
```

Omit `--actionable-only` only when intentionally measuring pre-AI / all technical BUYs.

## Interpret

- Prefer **mature** rows (hold period complete).
- Report: n, win rate, avg return, profit factor; slice by confidence, `ret_5d`, volume ratio when diagnosing losers.
- Tie conclusions to config knobs (`hard_reject_*`, continuation bands, AI gate) — do not invent execution advice.

## Document

- Add or update `docs/research/YYYY-MM/signal-strategy-research-YYYY-MM.md` (or dated note).
- Link CSV/JSON artifacts; state sample window and whether actionable-only.
- Keep markdown under `docs/` only.

## Related

- Pipeline overview: `docs/ai-signal-pipeline/README.md`
- Strategy narrative: `docs/bot-logic-and-strategy.md`
- Subagent: `/signal-strategy-researcher`
