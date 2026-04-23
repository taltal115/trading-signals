# Vanilla → Angular parity checklist

Use this when verifying behavior against the archived [`web/legacy-vanilla/app.js`](../web/legacy-vanilla/app.js) and [`web/styles.css`](../web/styles.css).

## Routes

- [x] `/dashboard`, `/universe`, `/signals`, `/positions`, `/monitor`, `/about`, `/about/run`, `/about/universe`, `/about/monitor`, `/login`, `/logout` (logout via shell)
- [x] Default / unknown → dashboard
- [x] Localhost: auth off, `/login` → redirect away via guard; read-only universe/signals

## Layout

- [x] Sidebar collapse + `localStorage` key `signals-sidebar-collapsed`
- [x] Mobile drawer + backdrop
- [x] Exit `<dialog>`: close position with same Firestore fields as legacy

## Universe

- [x] `orderBy ts_utc desc limit 30`, expandable rows, symbol details

## Signals

- [x] `orderBy ts_utc desc limit 25`
- [x] Columns: date, ticker, signal price, live price + refresh, entry, stop, target, conf, actions
- [x] Log Buy → inline form row, `colspan` 9, bracket sync, submit → `my_positions`
- [x] Re-eval → `trading-bot-scan.yml` dispatch
- [x] Snapshot clears inline form (same as legacy refresh behavior)

## Positions

- [x] Guest gate + localhost message
- [x] Manual “Log a fill” `<details>` form + bracket sync (disabled without signal %)
- [x] Hide closed toggle (default on)
- [x] PnL cards (total + daily) using live prices + previous-day closes
- [x] Table columns and sortable headers (new column → default **asc**; same column toggles)
- [x] 30s live price refresh for open positions
- [x] Spot cell, manual refresh, Finnhub with Firestore fallback
- [x] Exit → shell dialog
- [x] Monitor / History expand rows; checks query; history chart + tooltip
- [x] Check → `position-monitor.yml` dispatch

## Monitor page

- [x] `collectionGroup('checks')` with same ordering/limit intent as legacy
- [x] Guest gate

## About

- [x] Static copy aligned with legacy sections; internal links use `routerLink`

## Config parity

- [x] Allowlists: `environment.allowedSignInEmails` / `allowedAuthUids` (replace `web/firebase-config.js` for the live app)
- [x] Optional: Finnhub / Alpha Vantage / Twelve Data keys in environment (still public in browser until Nest)

## Styling

- [x] Global [`web/styles.css`](../web/styles.css) in Angular build
