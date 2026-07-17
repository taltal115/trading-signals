# Research notes

Dated strategy research lives in month folders so each cohort stays self-contained.

| Folder | Topic |
|--------|--------|
| [`2026-07/`](./2026-07/) | Breakout cohort analysis + profit-at-hold follow-up (incl. AI layer) |

For the next research cycle, create `docs/research/YYYY-MM/` and keep scripts, CSVs, and markdown together there.

Optional Finviz screener POC (research only, not production universe):

```bash
python3 scripts/finviz_screener_poc.py --mode screener --preset top-gainers --max-pages 2 --format csv --out docs/research/finviz_poc_sample.csv
```

