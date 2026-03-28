## signals-bot (signal-only)

This project scans US stocks on **daily candles** for **breakout-momentum** setups (1–7 day swing ideas), journals signals to **SQLite**, and posts the top results to **Slack**. It does **not** place orders.

### Docs
- Bot logic + strategy: `docs/bot-logic-and-strategy.md`
- Firebase Hosting + dashboard + position monitor: `docs/firebase-hosting-setup.md`

### What this is (and isn’t)
- **Signal-only**: generates BUY / WAIT / SELL guidance with confidence.
- **Manual execution**: you decide whether to trade; no broker integration.
- **Daily after close**: designed for end-of-day scanning and calmer decision-making.

### Quick start

1) Create a virtualenv:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

2) Install dependencies (via your proxy/mirror if needed):

```bash
python -m pip install -r requirements.txt
```

3) Create config + env files:

```bash
cp config.example.yaml config.yaml
cp env.example .env
```

4) Put your Slack credentials in `.env` (see `env.example`).

Optional: add `FINNHUB_API_KEY` to `.env` if you want Finnhub as the primary data provider or to use dynamic discovery.
Optional: add `FLEX_API_KEY` to `.env` to gate SELL signals by your IBKR OpenPositions (Flex API).
Optional: add **`GOOGLE_APPLICATION_CREDENTIALS`** (path to a service-account JSON) or **`FIREBASE_SERVICE_ACCOUNT_JSON`** (inline JSON) for Firestore — required for `universe.firestore.enabled`, discovery writes, and BUY signal archival.

5) Provide a universe:
- **Recommended**: set `universe.firestore.enabled: true`, run `./run.sh discovery` at least once so `universe/{asof_date}` exists in Firestore, then run `./run.sh`.
- Without Firestore: edit `config.yaml` — `universe.symbols`, or `universe.symbols_csv`, or `universe.symbols_dir` (CSV files with a `symbol` column).

6) Run:

```bash
./run.sh
```

### Dynamic discovery (separate job)

Build a dynamic universe each run from Finnhub symbols + your existing momentum/breakout filters. Prefer **`./run.sh discovery`** so the project venv and dependencies (including Finnhub) are used automatically:

```bash
./run.sh discovery --max-calls 400 --limit 500
# Per-symbol provider/signal trace:
./run.sh discovery -v --max-calls 400 --limit 500
```

You can also drive discovery from a custom watchlist (for example, defense or oil names) by passing a CSV with a `symbol` column:

```bash
./run.sh discovery \
  --symbols-csv data/universe_lists/defense_watchlist.csv \
  --max-calls 400 \
  --limit 500
```

Notes:
- Reads `FINNHUB_API_KEY` from `.env`.
- Requires Firestore credentials (`GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_SERVICE_ACCOUNT_JSON`); each run **`set`s** `universe/{asof_date}` with the ranked symbol list (NY date from `run.timezone`).
- Rotates coverage across days to stay within low API budgets.
- **CSV backup is optional**: pass `--output path/to/universe.csv` if you want a local file; the bot reads the universe from Firestore when `universe.firestore.enabled` is true.

You can schedule it separately (e.g., pre-market), then run `./run.sh` after it finishes. Advanced: you may still invoke `python scripts/update_universe_finnhub.py ...` directly after `source .venv/bin/activate`.

### Scheduled discovery (GitHub Actions)

Workflow [`.github/workflows/universe-discovery-daily.yml`](.github/workflows/universe-discovery-daily.yml) runs **weekdays** and writes the top **500** names to Firestore (`--limit 500`, `--max-calls 400`). It restores and saves **`universe-discovery-state`** artifacts so Finnhub **batch rotation** (`data/universe_state.json`) survives clean runners.

**Secrets:** `FINNHUB_API_KEY` and `FIREBASE_SERVICE_ACCOUNT_JSON` (same as the main scan workflow). Use **Actions → Daily universe discovery → Run workflow** to run manually.

### Firestore universe (optional but recommended)

- **Discovery** upserts one document per day: fields `asof_date`, `symbols`, `ts_utc`, `source`.
- **Main scan** loads symbols via `read_universe_for_date`: today’s doc, or the latest snapshot if `fallback_latest` is true and today’s doc is missing/empty.
- **CI**: add repo secret `FIREBASE_SERVICE_ACCOUNT_JSON` (full service account JSON string) so scheduled GitHub Actions runs can read the universe (see workflow env).

### Web dashboard (Firebase Hosting)

Static UI in [`web/`](web/) (universe history, signal runs, manual position form). Configure [`web/firebase-config.js`](web/firebase-config.js), deploy rules/indexes/hosting per [`docs/firebase-hosting-setup.md`](docs/firebase-hosting-setup.md). Sign-in is **Email/Password** (enable in Firebase Console).

### Position monitor (GitHub Actions)

[`scripts/monitor_open_positions.py`](scripts/monitor_open_positions.py) reads **`my_positions`** with `status == open`, pulls a **daily** last price (same providers as the bot), logs **`[WAIT]` / `[SELL]`**-style lines, updates **`last_alert_*`** on each doc, and posts **Slack** only when the alert **kind** changes (deduped). Scheduled workflow: [`.github/workflows/position-monitor.yml`](.github/workflows/position-monitor.yml). Optional secret **`MONITOR_OWNER_UID`** limits Firestore rows to one account. Local run:

```bash
PYTHONPATH=./src python scripts/monitor_open_positions.py --config config.yaml
```

### Slack test (optional)

```bash
python scripts/slack_test.py --channel C0123456789 --text "signals-bot test"
```

### IBKR Flex test (optional)

Fetch Flex report and print XML->JSON (requires `FLEX_API_KEY` in `.env`):

```bash
python3 scripts/ibkr_flex_test.py
```

Clean output (only OpenPositions + Trades):

```bash
python3 scripts/ibkr_flex_test.py --clean
```

### IBKR scanner test (optional)

Print symbols returned by IBKR market scanners (requires TWS or IB Gateway running):

```bash
python scripts/ibkr_scanner_test.py --config config.yaml
```

### Firestore connectivity test

```bash
python3 scripts/firebase_firestore_test.py --collection test --doc ping
```

### Finviz signals scrape (optional)

Print rows from the Finviz Signals table (`tbody#js-signals_1`):

```bash
python scripts/finviz_signals_scrape.py --limit 25
```

If your network does SSL interception, pass your CA bundle (recommended) or use `--insecure` as a last resort:

```bash
python scripts/finviz_signals_scrape.py --limit 25 --ca-bundle /path/to/corp-ca.pem
python scripts/finviz_signals_scrape.py --limit 25 --insecure
```

If Finviz returns HTTP 403/404 to requests-based scraping, the script will try a Playwright browser fallback. Install once:

```bash
python -m pip install playwright
playwright install chromium
```

Or run directly:

```bash
signals-bot --config config.yaml
```

### Output
- **Colored logs** in your terminal with clear BUY/WAIT/SELL lines + confidence.
- SQLite DB at `./data/signals.db` (append-only signal history).
- Slack message with top-ranked signals (if enabled).

### Notes
- Data is pulled from free sources (Yahoo via `yfinance`, with Stooq fallback). Free sources can be rate-limited or occasionally wrong.
- If you see SSL errors like `CERTIFICATE_VERIFY_FAILED` on a corporate network, set `data.ca_bundle_path` in `config.yaml` to your corporate CA bundle (preferred). As a last resort, set `data.ssl_verify: false`.
- Slack requires a **bot token** (`xoxb-...`) with `chat:write`. If you see `not_allowed_token_type`, your token is not a bot token.
- This is not financial advice.

