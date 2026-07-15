# Architecture

## Jobs

### Job 1 — Breakout scan (`signals_bot.main`)

- Emits technical BUY rows only.
- Each row includes `pipeline_stage: "technical"`, `ai_gate: "pending"`.
- No OpenAI calls.

### Job 2 — AI entry eval (`scripts.ai_stock_eval`)

- Inputs: `--signal-doc-id` (single ticker) or `--batch` over pending rows (capped by `ai.max_entry_evals_per_run`).
- Builds context (OHLCV, Finnhub news, features) → entry prompts → JSON verdict → blended score.
- Hard gate: `ai_gate=passed` only when `decision=BUY` **and** `total >= entry_min_total` **and** `conviction >= entry_min_conviction`.
- Otherwise `ai_gate=filtered` (row kept for history).
- On BUY pass: overrides `hold_days`, `stop`, `target` from `recommendation.plan`.
- Dual-write: slim `ai` + `recommendation` on the signal row; full record in `ai_evals`.

### Job 3 — Holding advisor (`scripts.ai_holding_advisor`)

- Targets open `my_positions`.
- Inputs: plan, PnL, days held, Finnhub news + social-sentiment.
- Output: `advice` ∈ `HOLD|TIGHTEN|EXTEND|EXIT`, optional revised `hold_days` / `stop`.
- Writes `holding_advice` + `ai` on the position; appends `ai_evals` with `stage=holding`.
- Price monitor remains authoritative for `STOP_HIT` / `TARGET_HIT`.

## Hard gate

Actionable Slack / UI “passed” list requires all of:

1. `recommendation.decision == "BUY"`
2. Blended `scores.total >= ai.entry_min_total`
3. LLM `conviction >= ai.entry_min_conviction`

## Firestore

| Location | Purpose |
|----------|---------|
| `signals/{runId}.signals[i]` | Technical BUY + latest `ai` / `recommendation` / `ai_gate` |
| `ai_evals/{evalId}` | Append-only history + tokens/model/cost |
| `my_positions/{id}` | `holding_advice` + latest `ai` summary |

See [USAGE_AND_ANALYTICS.md](./USAGE_AND_ANALYTICS.md) and [VERDICT_SCHEMA.md](./VERDICT_SCHEMA.md).
