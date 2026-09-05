# Signals live quotes — Massive (Polygon) WebSocket

Signals table **live price** (and in-progress hold chart tip) streams through Nest, not the browser.
Only tickers on the **current Signals page** are subscribed (page size ≤50).

## Plan fit

### Stocks Advanced (~$199) — real-time (recommended)

| Choice | Why |
|--------|-----|
| `POLYGON_WS_REALTIME=true` | Nest connects to `wss://socket.polygon.io/stocks` |
| Subscribe `A.{TICKER}` only | Per-second aggregates ≈ last price; avoid trades `T.` / quotes `Q.` (too much volume) |
| One upstream socket per API process | Massive allows one connection per cluster; Nest multiplexes clients |
| Page-scoped symbols only | Frontend sends tickers for the current Signals page (≤50); page change replaces the set |
| Idle teardown | When no client needs symbols, Nest closes the upstream socket |

### Stocks Starter (~$29) — 15‑minute delayed (default / rollback)

| Choice | Why |
|--------|-----|
| `POLYGON_WS_REALTIME` unset / false | Nest uses `wss://delayed.polygon.io/stocks` |
| Subscribe `AM.{TICKER}` | Per-minute aggregates (included on Starter) |

API key stays server-side (`POLYGON_API_KEY` / `MASSIVE_API_KEY`).

### Env overrides

| Variable | Purpose |
|----------|---------|
| `POLYGON_WS_REALTIME` / `MASSIVE_WS_REALTIME` | `true` → realtime socket + default channel `A` |
| `POLYGON_WS_URL` / `MASSIVE_WS_URL` | Full WS URL override (if set to `socket.polygon.io` / `socket.massive.io`, realtime is inferred) |
| `POLYGON_WS_CHANNEL` / `MASSIVE_WS_CHANNEL` | `A` or `AM` (overrides the default for the mode) |

## Flow

```
Angular Signals page
  → Socket.IO namespace `/market-quotes` path `/api/socket.io`
  → Nest MarketQuotesGateway (setSubscriptions, max 50 symbols/client)
  → PolygonWsHub (refcount + A./AM. subscribe/unsubscribe)
  → Massive realtime or delayed WS
```

- **Seed:** on subscribe, Nest REST `/quote` fills the cell until the first aggregate bar.
- **Manual ↻:** still uses REST `GET /api/market/quote` as a one-shot refresh.
- **Hold chart:** hourly candles stay REST; while the hold is in progress, the last bar close tracks the same page WS price.
- **Toolbar:** Signals page shows “Live feed: realtime” or “Live feed: 15m delayed” from Nest `hub_status`.

## Local

1. Backend: `cd backend && npm run start:dev` (needs `POLYGON_API_KEY` in repo `.env`).
2. For Advanced realtime: add `POLYGON_WS_REALTIME=true` to `.env`.
3. Frontend: `ng serve` — `proxy.conf.json` has `"ws": true` for `/api`.

## Deploy notes

- Firebase Hosting rewrite `/api/**` → Cloud Run covers `/api/socket.io` for **HTTP**.
- The browser on `*.web.app` / `*.firebaseapp.com` uses Socket.IO **HTTP polling only**. Hosting cannot complete the WebSocket upgrade (`wss://…/api/socket.io` failed). Polling still streams quotes.
- Local `ng serve` still prefers WebSocket (`proxy.conf.json` has `"ws": true`).
- `contentscript.js` MaxListeners / ObjectMultiplex lines are a **browser extension** (e.g. MetaMask), not this app.
- Set `POLYGON_WS_REALTIME=true` on Cloud Run when the key is Stocks Advanced.
- Cloud Run deploy enables **session affinity** (Socket.IO polling is sticky across instances).
