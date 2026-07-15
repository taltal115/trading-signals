# Usage and analytics — hybrid storage

## Why hybrid

| Approach | Verdict |
|----------|---------|
| Only under `signals[i]` | Bloats run docs; weak multi-eval history |
| Only separate collection | Table needs N queries for “has AI” |
| **Hybrid** | Table reads run once; expand queries `ai_evals` |

## A) Latest on the signal row

```json
{
  "ai_gate": "pending | passed | filtered",
  "recommendation": { "...clear verdict..." },
  "ai": {
    "has_eval": true,
    "eval_count": 3,
    "last_eval_id": "2026-07-15_us__AAPL__entry__20260715T093012Z",
    "last_at_utc": "2026-07-15T09:30:12Z",
    "last_stage": "entry",
    "last_decision": "BUY",
    "model": "gpt-5.4",
    "prompt_tokens": 4200,
    "completion_tokens": 800,
    "total_tokens": 5000,
    "estimated_cost_usd": 0.042,
    "cost_estimated": true
  }
}
```

Legacy `ai_evaluation` may still exist on older rows; UI prefers `recommendation` + `ai`.

## B) Collection `ai_evals`

Doc id: `{signal_doc_id}__{TICKER}__{stage}__{utcCompact}`

One document per LLM request: tokens, model, optional cost, full `recommendation`, optional `detail`.

Suggested indexes:

- `(signal_doc_id, ticker, ts_utc desc)` — per-row history
- `(stage, ts_utc)` / `(ticker, ts_utc)` — analytics

## Cost

Always store OpenAI `usage` token counts. Optional `config.ai.pricing[model].{prompt_per_1m,completion_per_1m}` → `estimated_cost_usd`. If missing: `estimated_cost_usd: null`, `cost_estimated: false`.

## UI

- **Signals table:** AI chip / View expand for stored evaluation (legacy `ai_evaluation` and newer `recommendation` + `ai`). Read-only — **no** dashboard buttons to start AI jobs.
- **`/ai-analytics`:** aggregates via `GET /api/ai-evals/recent` (requests / tokens / cost by stage, ticker, day).
- History reads also use `GET /api/ai-evals` (aliases under `/api/signals/ai-evals*` may exist).
- Run AI evaluation via [RUNBOOK.md](./RUNBOOK.md) (CLI or GitHub Actions).
