## signals-bot (signal-only)

This project scans US stocks on **daily candles** for **breakout-momentum** setups (1–7 day swing ideas), journals signals to **SQLite**, and posts the top results to **Slack**. It does **not** place orders.

### Docs
- All project docs under `docs/` — also readable in the SPA under **About** (in-app Markdown viewer)
- Bot logic + strategy: `docs/bot-logic-and-strategy.md`
- AI signal pipeline (entry gate + holding advisor): `docs/ai-signal-pipeline/README.md`
- Firebase Hosting + dashboard + position monitor: `docs/firebase-hosting-setup.md`
- Angular dashboard architecture: `docs/frontend-angular-architecture.md`
- IBKR Client Portal Gateway (live portfolio + cloud sync plan): `docs/ibkr-client-portal-gateway-plan.md`

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
Optional: add **`GOOGLE_APPLICATION_CREDENTIALS`** — path to your service account JSON file locally; or in **GitHub Actions**, set the repository secret to the **full JSON text** of that file (value must start with `{`). Required for `universe.firestore.enabled`, discovery writes, BUY signal archival, and IBKR portfolio sync.
Optional: configure **IBKR holdings** so the bot knows what you own (for SELL gating). See [IBKR portfolio integration](#ibkr-portfolio-integration-optional) below — **Client Portal Gateway** (live) or **Flex API** (batch fallback).

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
- Requires **`GOOGLE_APPLICATION_CREDENTIALS`** (file path locally, or full JSON string in CI); each run **`set`s** `universe/{asof_date}` with the ranked symbol list (NY date from `run.timezone`).
- Rotates coverage across days to stay within low API budgets.
- **CSV backup is optional**: pass `--output path/to/universe.csv` if you want a local file; the bot reads the universe from Firestore when `universe.firestore.enabled` is true.

You can schedule it separately (e.g., pre-market), then run `./run.sh` after it finishes. Advanced: you may still invoke `python scripts/update_universe_finnhub.py ...` directly after `source .venv/bin/activate`.

### Scheduled discovery (GitHub Actions)

Workflow [`.github/workflows/universe-discovery-daily.yml`](.github/workflows/universe-discovery-daily.yml) runs **Monday–Friday** about **2 hours before the US cash open** (07:30 `America/New_York`): two UTC crons fire, and a small gate keeps the run only when NY local time matches (handles EST vs EDT). **`workflow_dispatch`** runs immediately without that gate. It runs `update_universe_finnhub.py` with `--max-calls 2000` and restores/saves **`universe-discovery-state`** artifacts so Finnhub **batch rotation** (`data/universe_state.json`) survives clean runners.

**Secrets:** `FINNHUB_API_KEY` and **`GOOGLE_APPLICATION_CREDENTIALS`** (full service account JSON as the secret value). Use **Actions → Daily universe discovery → Run workflow** to run manually.

The **main bot scan** workflow [`.github/workflows/trading-bot-scan.yml`](.github/workflows/trading-bot-scan.yml) runs **weekdays** about **1 hour before the US cash open** (08:30 `America/New_York`), with the same “two UTC crons + NY time gate” pattern. **`workflow_dispatch`** can run it any time, optionally for a single `--ticker`.

### Firestore universe (optional but recommended)

- **Discovery** upserts one document per day: fields `asof_date`, `symbols` (full history list), **`active_symbols`** + **`active_count`** (the curated scan list), **`inactive_count`**, optional **`status_counts`**, `ts_utc`, `source`, and per-symbol details (`status`, `last_action`, `last_score`, `last_confidence` as setup strength, streaks).
- **Main scan** loads **`active_symbols`**. Empty active lists do **not** expand to the full history pool; the loader tries a recent snapshot with actives, then errors. Legacy docs without `active_symbols` still fall back to `symbols`.
- **CI**: add repo secret **`GOOGLE_APPLICATION_CREDENTIALS`** with the full service account JSON text (the workflows inject it into that env var).

#### How active / inactive is decided each run

`scripts/update_universe_finnhub.py` does, in order:

1. **Today's batch** — rotates through Finnhub up to `--max-calls`, runs the breakout strategy.
2. **Carry-over re-validation** — unions the **last `--merge-days` snapshots' symbols**, then re-runs the strategy (capped by **`--revalidate-cap`**).
3. **Active eligibility** — **BUY** with setup score ≥ **`--min-confidence`**, or **WAIT** with setup score ≥ **`--watch-min-confidence`** (high-setup watch). SELL never active. Weak BUY → `inactive_below_min`; weak WAIT → `inactive_wait`.
4. **Stale rule** — applies only to **non-eligible** symbols (`--stale-days` / `--stale-runs`). A fresh eligible BUY/WAIT is never blocked by an old streak.
5. **Top-K cap** — keep at most **`--top-k`** actives (BUY ranked above WAIT, then setup score). Remainder → `inactive_capped`.
6. **Write** — `universe/{asof_date}` with `active_symbols`, counts, `status_counts`, and symbol subdocs (`last_action`, `active_kind`).

Setup score (`last_confidence`) is **deterministic rule strength**, not expected return. Prefer the **Signals** page for actionable ideas.

```bash
PYTHONPATH=./src python scripts/update_universe_finnhub.py \
  --config config.yaml \
  --max-calls 2000 \
  --merge-days 7 \
  --top-k 200 \
  --min-confidence 50 \
  --watch-min-confidence 55 \
  --stale-runs 5 \
  --stale-days 14 \
  --revalidate-cap 1000
```

### Web dashboard (Firebase Hosting)

Angular SPA under [`frontend/`](frontend/) (Hosting). Data via Nest API; build with `cd frontend && npm ci && npx ng build`. Setup: [`docs/firebase-hosting-setup.md`](docs/firebase-hosting-setup.md). Docs library is available in-app under **About**.

### Position monitor (GitHub Actions)

[`scripts/monitor_open_positions.py`](scripts/monitor_open_positions.py) reads **`my_positions`** with `status == open`, pulls a **daily** last price (same providers as the bot), logs **`[WAIT]` / `[SELL]`**-style lines, updates **`last_alert_*`** on each doc, and posts **Slack** only when the alert **kind** changes (deduped). Scheduled workflow: [`.github/workflows/position-monitor.yml`](.github/workflows/position-monitor.yml). Optional secret **`MONITOR_OWNER_UID`** limits Firestore rows to one account. Local run:

```bash
PYTHONPATH=./src python scripts/monitor_open_positions.py --config config.yaml
```

### Slack test (optional)

```bash
python scripts/slack_test.py --channel C0123456789 --text "signals-bot test"
```

### IBKR portfolio integration (optional)

The bot is **signal-only** (no order placement), but it uses your **open IBKR holdings** to:

- Know which tickers you **actually hold** when evaluating **SELL** exits (stop / time exit vs SQLite open buys).
- Log holdings at the start of each scan (`IBKR holding: …` lines).

Market **prices** for signals still come from **Yahoo / Stooq**, not IBKR. IBKR integration here is **portfolio context only**.

#### Three IBKR options (pick one for holdings)

| Method | Freshness | Runs in GitHub Actions? | Best for |
|--------|-----------|-------------------------|----------|
| **Client Portal Gateway** (`localhost:5000`) | Near real-time | **No** — sync to Firestore from a local machine or VM | Live positions, cloud via Firestore |
| **Flex Web Service** (`FLEX_API_KEY`) | Often end-of-day | **Yes** | Simple CI fallback when gateway sync is unavailable |
| **IBKR scanner** (TWS / IB Gateway `:7497`) | Intraday symbol lists | No | Extra **universe** tickers — not holdings |

**Recommended:** Client Portal Gateway + Firestore sync. Keep Flex as fallback.

Full architecture and cloud deployment: [`docs/ibkr-client-portal-gateway-plan.md`](docs/ibkr-client-portal-gateway-plan.md).

---

#### Client Portal Gateway (live portfolio)

IBKR’s **Client Portal Gateway** is a small Java app that exposes a REST API at:

`https://localhost:5000/v1/api/`

After you log in through the gateway’s web UI, the bot can read **open positions**, **account summary**, and (later) place no orders — this repo only **reads** data.

**Why use it instead of Flex?** Flex generates **batch reports** that often lag same-day trades. The gateway reflects your **current session** and is much better for “what do I hold right now?”.

##### 1. Install and authenticate (one-time per session)

1. Download **Client Portal Gateway** from [IBKR Campus — Web API](https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/).
2. Start it (typical layout):
   ```bash
   cd clientportal.gw
   bin/run.sh root/conf.yaml
   ```
3. Open **`https://localhost:5000`** in a browser → log in (paper or live) → complete 2FA.
4. Confirm the session:
   ```bash
   curl -k 'https://localhost:5000/v1/api/iserver/auth/status'
   ```
   Expect `"authenticated": true`.

**macOS:** if port 5000 is in use (often AirPlay Receiver), change `listenPort` in `root/conf.yaml` (e.g. `5001`) and update `base_url` below.

The gateway uses a **self-signed certificate** — Python sets `verify_ssl: false` for local calls.

##### 2. Enable in `config.yaml`

```yaml
ibkr:
  client_portal:
    enabled: true
    base_url: "https://localhost:5000/v1/api"
    verify_ssl: false
    account_id: ""                    # optional; first account if empty
    collection: "ibkr_portfolio"      # Firestore collection name
    snapshot_max_age_min: 30          # bot trusts Firestore snapshots this fresh
    sync_interval_min: 5                # used by --loop sync script
```

Optional **`.env`** overrides (see `.env.example`):

```bash
IBKR_CP_GATEWAY_URL=https://localhost:5000/v1/api
IBKR_CP_ACCOUNT_ID=U1234567
```

##### 3. Test connectivity

```bash
PYTHONPATH=./src python scripts/ibkr_cp_gateway_test.py --config config.yaml
```

Human-readable positions only:

```bash
PYTHONPATH=./src python scripts/ibkr_cp_gateway_test.py --config config.yaml --positions-only
```

##### 4. Sync to Firestore (for CI and cloud)

The premarket bot on **GitHub Actions cannot reach `localhost:5000` on your Mac**. Instead, a sync job writes holdings to Firestore; the bot reads that snapshot.

```bash
# Fetch only — no Firestore write
PYTHONPATH=./src python scripts/sync_ibkr_portfolio.py --config config.yaml --dry-run

# Write to Firestore ibkr_portfolio/{account_id} and ibkr_portfolio/latest
PYTHONPATH=./src python scripts/sync_ibkr_portfolio.py --config config.yaml

# Continuous sync (for a home server or cloud VM)
PYTHONPATH=./src python scripts/sync_ibkr_portfolio.py --config config.yaml --loop
```

Requires **`GOOGLE_APPLICATION_CREDENTIALS`** (same as universe / signals).

**Firestore documents** (`ibkr_portfolio` collection):

- `latest` — most recent snapshot (what the bot reads in CI)
- `{account_id}` — same payload keyed by IBKR account

Each snapshot includes: `ts_utc`, `account_id`, `positions[]` (ticker, qty, avg_cost, mkt_value, …), `summary` (NLV, buying power, …), `source: client_portal_gateway`.

##### 5. How the bot resolves holdings

When `ibkr.client_portal.enabled: true`, each `./run.sh` / main scan uses this order:

1. **Firestore** — if `ibkr_portfolio/latest` exists and is younger than `snapshot_max_age_min` minutes.
2. **Live gateway** — fetch from `localhost:5000`, then **write-through** to Firestore.
3. **Flex fallback** — if `FLEX_API_KEY` is set and the above fail.
4. **No gate** — scan continues without holdings (SELL logic won’t know your IBKR book).

For **GitHub Actions**, run `sync_ibkr_portfolio.py --loop` on a machine where the gateway stays logged in; the scheduled workflow only needs Firestore credentials.

##### 6. Cloud later (summary)

Deploy the gateway + sync loop on a **small always-on VM** (not Cloud Run / GHA). Bind port 5000 to `127.0.0.1` only. Details: [`docs/ibkr-client-portal-gateway-plan.md`](docs/ibkr-client-portal-gateway-plan.md).

**Troubleshooting**

| Symptom | Fix |
|---------|-----|
| `not authenticated` | Re-open `https://localhost:5000` and log in |
| Connection refused | Start the gateway JVM |
| Empty positions | Check `account_id`; verify `/portfolio/accounts` |
| Bot ignores Firestore in CI | Run sync; check `ts_utc` vs `snapshot_max_age_min` |
| SSL errors | Keep `verify_ssl: false` for local gateway |

---

#### Flex API (batch fallback)

Flex pulls a **generated XML report** from IBKR’s cloud (no local gateway). It works from GitHub Actions but is often **stale** until end-of-day.

1. Create a Flex Query in Client Portal (Open Positions + Trades) and note the **Query ID**.
2. Generate a **Flex token** and set in `.env`:
   ```bash
   FLEX_API_KEY=your_token
   ```
3. Test:
   ```bash
   python3 scripts/ibkr_flex_test.py --query-id YOUR_QUERY_ID --clean
   ```

The bot uses Flex automatically when Client Portal is disabled or unavailable. Code default query id is `1404030` — override with `--query-id` if yours differs.

---

#### IBKR scanner (universe only)

Separate from holdings: pulls **market scanner** symbols via TWS / IB Gateway (`ibkr.port`, default `7497`) and `ib-insync`.

Requires TWS or IB Gateway running with API enabled. Enable in `config.yaml` under `universe.ibkr_scanner`.

```bash
python scripts/ibkr_scanner_test.py --config config.yaml
```


### Firestore connectivity test

```bash
python3 scripts/firebase_firestore_test.py --collection test --doc ping
```

### Finviz scrape POC (optional, research only)

Scrapes Finviz **homepage signal cards** (`.hp_home-signal-card-cell`: Ticker, Last, Change, Volume, Signal) or **screener** Overview tables via `requests` + BeautifulSoup.
Quotes are delayed; output is for personal research, not the production universe pipeline.

```bash
# Homepage signal widget (default) — prints a table like finviz.com
python3 scripts/finviz_screener_poc.py

# Filter by signal label (e.g. only "New High" rows)
python3 scripts/finviz_screener_poc.py --signal-filter "New High"

# Screener mode: named preset (top gainers, unusual volume, …)
python3 scripts/finviz_screener_poc.py --mode screener --preset top-gainers --max-pages 2 --format csv --limit 40

# Screener mode: copy a filter URL from the Finviz UI (most consistent)
python3 scripts/finviz_screener_poc.py --mode screener \
  --url "https://finviz.com/screener?v=111&f=geo_usa,sh_price_o2" \
  --max-pages 3 --format csv \
  --out docs/research/finviz_poc_sample.csv
```

If your network does SSL interception, pass your CA bundle (recommended) or use `--insecure` as a last resort:

```bash
python3 scripts/finviz_screener_poc.py --ca-bundle /path/to/corp-ca.pem
python3 scripts/finviz_screener_poc.py --mode screener --preset top-gainers --insecure
```

If Finviz returns HTTP 403/503 to requests-based scraping, the script tries a Playwright browser fallback. Install once:

```bash
python -m pip install playwright
playwright install chromium
```

Or run the main bot directly:

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

