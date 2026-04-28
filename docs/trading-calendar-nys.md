# NYSE trading calendar (XNYS)

This project counts **NYSE regular sessions** via [`exchange_calendars`](https://github.com/gerrymanoim/exchange_calendars) calendar **`XNYS`**.

## Semantics

- **Anchor timezone:** `America/New_York` (see `config.yaml` `run.timezone`) for interpreting `created_at_utc` vs “now” in the position monitor (same as before).
- **Early-close days** (e.g. day before Independence Day) still count as **one** trading day toward holds — the exchange still runs a regular shortened session.
- **Full market holidays** (e.g. MLK, Good Friday when closed) do **not** count.
- **Open BUY / SQLite time exit** ([`src/signals_bot/strategy/breakout.py`](../src/signals_bot/strategy/breakout.py)): `open_buy_age_days` is the number of **NYSE session dates** strictly after `buy_asof_date` through `asof_date` (inclusive of `asof` when it is a session). Same idea as “sessions since buy,” not raw `timedelta.days`.
- **Position monitor** ([`scripts/monitor_open_positions.py`](../scripts/monitor_open_positions.py)): steps forward one **calendar** day at a time in `America/New_York` and counts a day only if `XNYS` lists a session for that calendar date (parity with the dashboard).
- **Angular** ([`frontend/src/app/core/positions-logic.ts`](../frontend/src/app/core/positions-logic.ts)): `addTradingDays` / `countTradingDaysBetween` use **Luxon** in `America/New_York` plus the generated session set ([`frontend/src/generated/nyse-session-set.generated.ts`](../frontend/src/generated/nyse-session-set.generated.ts)).
- **Legacy vanilla** ([`web/legacy-vanilla/`](../web/legacy-vanilla/)): loads the same data from [`nyse-session-set.generated.js`](../web/legacy-vanilla/nyse-session-set.generated.js) plus **Luxon** from the CDN (see `index.html`).
- **Dashboard market status** ([`frontend/src/app/core/nyse-market-clock.ts`](../frontend/src/app/core/nyse-market-clock.ts), component [`market-status-bar`](../frontend/src/app/layout/market-status-bar/)): green when **regular hours** (9:30–16:00 ET) apply on an XNYS session day; red otherwise. Countdown is to the next **regular** open or to **4:00 PM** close while open. **Early-close** session days (shortened close) are still shown as “open” until 4:00 ET in the UI — for exact intraday close times, use a broker calendar.

## Regenerating frontend data

Whenever you upgrade `exchange_calendars` in [`requirements.txt`](../requirements.txt), or when the generated range should be extended (upstream extends the XNYS bounds), run:

```bash
PYTHONPATH=./src python scripts/generate_nyse_calendar_data.py
```

This refreshes:

- `frontend/src/generated/nyse-session-set.generated.ts`
- `web/legacy-vanilla/nyse-session-set.generated.js`

Commit the updated files. Session lists are clamped to **`exchange_calendars`’ XNYS bounds** (`first_session` … `last_session`); if the library’s range is extended in a future release, re-run the script to cover more years.

## Tests

```bash
PYTHONPATH=src pytest scripts/test_trading_calendar_nys.py
```

## Calendar drift CI

Workflow [`.github/workflows/nyse-calendar-drift.yml`](../.github/workflows/nyse-calendar-drift.yml) re-runs the generator and fails if the committed generated files do not match (so upgrades cannot be forgotten).
