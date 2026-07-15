# Runbook

> **Triggers:** run these from CLI or GitHub Actions (`workflow_dispatch`). The dashboard does **not** offer Re-eval / AI eval buttons, and Nest does **not** expose `bot-scan` / `ai-stock-eval` dispatch routes. The UI only **displays** stored AI summaries (Signals AI column / View).

## Job flow (scheduled)

1. **Daily universe discovery** — builds `universe/{date}`
2. **Premarket trading bot scan** — BUY rows + **auto-opens paper positions** (`owner_uid=__signal_paper__`)
3. **AI entry batch** — cron after scan + `workflow_run` after scan success; screens pending + refreshes paper plans
4. **AI stock evaluation** — scheduled batch catch-up (or manual single ticker)
5. **AI holding advisor** — cron during session + after entry batch; `--paper-only` by default; writes `holding_advice` onto signal rows

Paper positions live in `my_positions` with deterministic ids `paper__{signalDocId}__{TICKER}` so holding/monitor flows apply to every bot BUY without manual Log Buy.

## Job 1 — Scan

```bash
./run.sh
```

GHA: `.github/workflows/trading-bot-scan.yml`

## Job 2 — AI entry (single)

```bash
scripts/run_ai_stock_eval.sh \
  --ticker AAPL \
  --signal-doc-id <run_doc_id>
```

## Job 2 — AI entry (batch pending)

```bash
PYTHONPATH=./src:. python -m scripts.ai_stock_eval.main \
  --config config.yaml \
  --batch \
  --signal-doc-id <run_doc_id>
```

Omit `--signal-doc-id` with `--batch` to evaluate the latest run’s pending rows.

GHA: `.github/workflows/ai-entry-batch.yml` (primary) and `.github/workflows/ai-stock-eval.yml` (batch schedule + optional single).

## Job 3 — Holding advisor

```bash
PYTHONPATH=./src:. python -m scripts.ai_holding_advisor.main --config config.yaml --paper-only
```

GHA: `.github/workflows/ai-holding-advisor.yml`

## Verify context only

```bash
PYTHONPATH=./src:. python -m scripts.ai_stock_eval.main \
  --ticker AAPL --signal-doc-id <id> --verify-only
```

## Secrets

| Secret | Used by |
|--------|---------|
| `GOOGLE_APPLICATION_CREDENTIALS` | Firestore |
| `FINNHUB_API_KEY` | Quote + company news + social |
| `OPENAI_API_KEY` | Entry + holding LLM |
| `NEWSAPI_API_KEY` | Optional broader headlines (merged with Finnhub/GDELT) |
| `FRED_API_KEY` | Optional CPI/rates/macro lines in `{{events}}` |

GDELT needs no secret (`USE_GDELT=true` by default). Toggle providers with repo variables `USE_NEWSAPI` / `USE_GDELT` / `USE_FRED`.

## Models (`config.yaml` `ai:`)

| Role | Default | When |
|------|---------|------|
| Entry gate | `gpt-5.4` (`entry_model`) | Every pending BUY eval |
| Entry (optional) | `gpt-5.4-pro` (`pro_model`) | When blended `technical_score` ≥ `pro_min_technical_score` (default 75) |
| Holding advisor | `gpt-5.4-mini` (`holding_model`) | Session holding runs |
