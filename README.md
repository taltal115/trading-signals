## signals-bot (signal-only)

This project scans US stocks on **daily candles** for **breakout-momentum** setups (1–7 day swing ideas), journals signals to **SQLite**, and posts the top results to **Slack**. It does **not** place orders.

### Docs
- Bot logic + strategy: `docs/bot-logic-and-strategy.md`

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

5) Provide a universe:
- Easiest: edit `config.yaml` and set `universe.symbols` to a short list.
- Better: provide `universe.symbols_csv` with a `symbol` column.

6) Run:

```bash
./run.sh
```

### Slack test (optional)

```bash
python scripts/slack_test.py --channel C0123456789 --text "signals-bot test"
```

### IBKR scanner test (optional)

Print symbols returned by IBKR market scanners (requires TWS or IB Gateway running):

```bash
python scripts/ibkr_scanner_test.py --config config.yaml
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

