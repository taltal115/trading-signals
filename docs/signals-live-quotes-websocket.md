# Signals live quotes — Massive (Polygon) WebSocket

Signals table **live price** (and in-progress hold chart tip) streams through Nest, not the browser.

## Plan fit (Stocks Starter ~$29)

| Choice | Why |
|--------|-----|
| `wss://delayed.polygon.io/stocks` | Starter is **15‑minute delayed**, not real-time |
| Subscribe `AM.{TICKER}` only | Per-minute aggregates (included); avoid trades `T.` (not on Starter) |
| One upstream socket per API process | Massive allows one connection per cluster; Nest multiplexes clients |
| Page-scoped symbols only | Frontend sends tickers for the current Signals page (≤50); page change replaces the set |
| Idle teardown | When no client needs symbols, Nest closes the upstream socket |

API key stays server-side (`POLYGON_API_KEY` / `MASSIVE_API_KEY`). Optional override: `POLYGON_WS_URL` / `MASSIVE_WS_URL`.

## Flow

```
Angular Signals page
  → Socket.IO namespace `/market-quotes` path `/api/socket.io`
  → Nest MarketQuotesGateway (setSubscriptions)
  → PolygonWsHub (refcount + AM subscribe/unsubscribe)
  → Massive delayed WS
```

- **Seed:** on subscribe, Nest REST `/quote` fills the cell until the first AM bar.
- **Manual ↻:** still uses REST `GET /api/market/quote` as a one-shot refresh.
- **Hold chart:** hourly candles stay REST; while the hold is in progress, the last bar close tracks the same page WS price.

## Local

1. Backend: `cd backend && npm run start:dev` (needs `POLYGON_API_KEY` in repo `.env`).
2. Frontend: `ng serve` — `proxy.conf.json` has `"ws": true` for `/api`.

## Deploy notes

- Firebase Hosting rewrite `/api/**` → Cloud Run already covers `/api/socket.io`.
- Prefer **session affinity** on Cloud Run if you run multiple instances (Socket.IO sticky).
