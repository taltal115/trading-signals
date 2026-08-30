# Research notes

Dated strategy research lives in month folders so each cohort stays self-contained.

| Folder | Topic |
|--------|--------|
| [`2026-07/`](./2026-07/) | Breakout cohort analysis + profit-at-hold follow-up (incl. AI layer) |
| [`2026-08/`](./2026-08/) | Post-fix failure analysis: why recent 3d-hold BUYs lost money |

For the next research cycle, create `docs/research/YYYY-MM/` and keep scripts, CSVs, and markdown together there.

## Dashboard Research UI

The Angular **Research** page (`/research`) triggers profit-hold cohort runs via Nest → GitHub Action [`profit-hold-research.yml`](../../.github/workflows/profit-hold-research.yml).

- **Canonical storage:** Firestore collection `research_runs` (summary, course of action, `researched_at_utc`, `next_research.due_date`).
- **Runner:** [`scripts/run_ui_profit_hold_research.py`](../../scripts/run_ui_profit_hold_research.py) (+ COA in [`scripts/research_coa.py`](../../scripts/research_coa.py)).
- **Schedule:** weekday due-check; full cohort when `next_research.due_date` ≤ today; Slack on due/complete.
- Local markdown/CSV under this folder remains useful for git notes; the UI reads Firestore.

```bash
PYTHONPATH=./src:. python scripts/run_ui_profit_hold_research.py \
  --since 2026-08-04 --notify-slack --write-local
```

Optional Finviz screener POC (research only, not production universe):

```bash
python3 scripts/finviz_screener_poc.py --mode screener --preset top-gainers --max-pages 2 --format csv --out docs/research/finviz_poc_sample.csv
```

