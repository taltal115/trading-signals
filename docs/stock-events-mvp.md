# Stock events MVP (discover + display)

Signal-only: upcoming financial events for the **top 200 universe symbols by `last_score`**, stored in Firestore and shown on the dashboard **Events** page.

## Data flow

1. **Universe discovery** (`update_universe_finnhub.py`) writes scores to `universe/{asof_date}/symbols/{TICKER}`.
2. **Events discovery** (`discover_stock_events.py`) reads top 200 by `last_score`, fetches calendars, writes `stock_events/{asof_date}`.
3. **Nest** `GET /api/events/latest` returns the latest snapshot (session required).
4. **Angular** `/events` renders a table.

## Firestore schema

**Collection:** `stock_events` (override via `config.yaml` → `events.collection`)

**Document:** `stock_events/{asof_date}` (NY date from `run.timezone`)

| Field | Description |
| ----- | ----------- |
| `asof_date` | Run date |
| `ts_utc` | Write timestamp (UTC ISO) |
| `source` | `discover_stock_events` |
| `universe_doc_id` | Universe snapshot used |
| `top_symbols_n` | Symbol count (typically 200) |
| `rank_by` | `last_score` |
| `horizon_days` | Forward window |
| `events` | Array of event rows |

Each event row: `symbol`, `event_type` (`earnings` / `ex_dividend` / `dividend`), `event_date`, `event_time`, `title`, `eps_estimate`, `revenue_estimate`, `last_score`, `last_confidence`, `data_source` (`finnhub` / `yahoo`).

## Providers

| Provider | Role |
| -------- | ---- |
| **Finnhub** | One batch `earnings_calendar(from, to)` call; filter to top-200 symbols |
| **Yahoo / yfinance** | Per-symbol fallback when Finnhub has no earnings in the window (earnings + ex-dividend / dividend dates) |

Requires `FINNHUB_API_KEY` for Finnhub. Yahoo fallback works without extra keys.

## Configuration

[`config.yaml`](../config.yaml):

```yaml
events:
  top_symbols: 200
  horizon_days: 21
  rank_by: last_score
  collection: stock_events
```

## Local run

```bash
# Dry run (no Firestore write)
PYTHONPATH=./src python scripts/discover_stock_events.py --config config.yaml --dry-run

# Write snapshot
PYTHONPATH=./src python scripts/discover_stock_events.py --config config.yaml

# Debug Finnhub calendar
python scripts/finnhub_test.py --endpoint earnings-calendar --from-date 2026-06-04 --to-date 2026-06-25
```

Needs `GOOGLE_APPLICATION_CREDENTIALS` and a recent `universe/{date}` with scored symbols in the `symbols` subcollection.

## GitHub Actions

Workflow [`.github/workflows/stock-events-daily.yml`](../.github/workflows/stock-events-daily.yml):

- **Schedule:** weekdays ~**08:00 America/New_York** (after universe discovery ~07:30).
- **Manual:** Actions → **Daily stock events discovery** → Run workflow.
- **Secrets:** `FINNHUB_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS` (same as universe discovery).

## API and UI

- `GET /api/events/latest` — see [`docs/backend-api.md`](backend-api.md).
- Dashboard route: `/events` (sidebar **Events**).

## Out of scope (this MVP)

Post-event trend prediction, LLM scoring, Slack alerts, bot scan integration.
