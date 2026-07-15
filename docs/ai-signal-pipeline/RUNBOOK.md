# Runbook

> **Triggers:** run these from CLI or GitHub Actions (`workflow_dispatch`). The dashboard does **not** offer Re-eval / AI eval buttons, and Nest does **not** expose `bot-scan` / `ai-stock-eval` dispatch routes. The UI only **displays** stored AI summaries (Signals AI column / View).

## Job 1 — Scan

```bash
./run.sh
# or
PYTHONPATH=./src python -m signals_bot.main --config config.yaml
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

GHA: `.github/workflows/ai-stock-eval.yml` (manual ticker) and `.github/workflows/ai-entry-batch.yml` (batch / after scan).

## Job 3 — Holding advisor

```bash
PYTHONPATH=./src:. python -m scripts.ai_holding_advisor.main --config config.yaml
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
| `FINNHUB_API_KEY` | News + social |
| `OPENAI_API_KEY` | Entry + holding LLM |
