import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

/** Rate-limit / plan-denial style messages — avoid noisy console warnings. */
export function isProviderQuotaMessage(msg: string): boolean {
  return /rate limit|too many requests|frequency limit|429|temporarily unavailable|provider limit|plan limit|access denied|finnhub candle|twelve data|no chart data|chart data/i.test(
    String(msg || '')
  );
}

export function isProviderQuotaError(err: unknown): boolean {
  return err instanceof Error && isProviderQuotaMessage(err.message);
}

export interface DailyCandles {
  t: number[];
  c: number[];
  o: number[];
}

/** Matches Nest `StockSnapshotDto` from `/api/market/snapshot`. */
export interface StockSnapshot {
  symbol: string;
  name: string | null;
  currency: string | null;
  exchange: string | null;
  country: string | null;
  industry: string | null;
  ipo: string | null;
  weburl: string | null;
  marketCapitalizationMillions: number | null;
  shareOutstanding: number | null;
  quote: {
    current: number | null;
    change: number | null;
    pctChange: number | null;
    high: number | null;
    low: number | null;
    open: number | null;
    prevClose: number | null;
    time: number | null;
  };
}

/**
 * Market data via Nest `/api/market/*` (Finnhub + optional Twelve Data on the server).
 * Keys live in `FINNHUB_API_KEY` / `TWELVE_DATA_API_KEY` — not in the browser.
 */
@Injectable({ providedIn: 'root' })
export class MarketDataService {
  private readonly quoteCache = new Map<string, { ts: number; price: number }>();
  private readonly QUOTE_TTL_MS = 5 * 60 * 1000;
  private readonly dailyCandlesCache = new Map<string, { ts: number; data: DailyCandles }>();
  private readonly DAILY_CANDLES_TTL_MS = 5 * 60 * 1000;
  private readonly snapshotCache = new Map<string, { ts: number; data: StockSnapshot }>();
  private readonly SNAPSHOT_TTL_MS = 10 * 60 * 1000;
  /** After candles API errors (e.g. Finnhub plan 403), skip HTTP until this time — avoids console/network spam. */
  private candlesHttpBackoffUntil = 0;
  private readonly CANDLES_HTTP_BACKOFF_MS = 30 * 60 * 1000;
  /** One candle HTTP at a time so parallel mini-charts do not spam `/api/market/candles` before backoff applies. */
  private candlesClientChain: Promise<unknown> = Promise.resolve();

  private get base(): string {
    return environment.apiBaseUrl;
  }

  private async readApiError(res: Response): Promise<string> {
    try {
      const j = (await res.json()) as { message?: string | string[] };
      const m = j.message;
      if (Array.isArray(m)) return m.join('; ');
      if (typeof m === 'string') return m;
    } catch {
      /* ignore */
    }
    return res.statusText || 'HTTP ' + res.status;
  }

  async fetchLivePrice(ticker: string): Promise<number> {
    const sym = String(ticker || '')
      .trim()
      .toUpperCase();
    if (!sym) throw new Error('Missing ticker');

    const qc = this.quoteCache.get(sym);
    if (qc && Date.now() - qc.ts < this.QUOTE_TTL_MS) {
      return qc.price;
    }

    const url = `${this.base}/api/market/quote?symbol=${encodeURIComponent(sym)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(await this.readApiError(res));
    }
    const data = (await res.json()) as { c?: number };
    if (data.c == null || data.c === 0) throw new Error('No price data');
    this.quoteCache.set(sym, { ts: Date.now(), price: data.c });
    return data.c;
  }

  async fetchStockSnapshot(ticker: string): Promise<StockSnapshot> {
    const sym = String(ticker || '')
      .trim()
      .toUpperCase();
    if (!sym) throw new Error('Missing ticker');

    const cached = this.snapshotCache.get(sym);
    if (cached && Date.now() - cached.ts < this.SNAPSHOT_TTL_MS) {
      return cached.data;
    }

    const url = `${this.base}/api/market/snapshot?symbol=${encodeURIComponent(sym)}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) {
      throw new Error(await this.readApiError(res));
    }
    const data = (await res.json()) as StockSnapshot;
    this.snapshotCache.set(sym, { ts: Date.now(), data });
    return data;
  }

  async fetchDailyCandles(ticker: string, days: number): Promise<DailyCandles> {
    const sym = String(ticker || '')
      .trim()
      .toUpperCase();
    if (!sym) throw new Error('Missing ticker');

    const cacheKey = `${sym}:${days}`;
    const cached = this.dailyCandlesCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.DAILY_CANDLES_TTL_MS) {
      return cached.data;
    }

    const run = this.candlesClientChain.then(() => this.fetchDailyCandlesNetwork(sym, days, cacheKey));
    this.candlesClientChain = run.then(
      () => undefined,
      () => undefined
    );
    return run as Promise<DailyCandles>;
  }

  private async fetchDailyCandlesNetwork(
    sym: string,
    days: number,
    cacheKey: string
  ): Promise<DailyCandles> {
    const now = Date.now();
    if (now < this.candlesHttpBackoffUntil) {
      throw new Error(
        'Chart data temporarily unavailable (provider limit). Set TWELVE_DATA_API_KEY on the API server or wait.'
      );
    }

    const d = Math.min(500, Math.max(2, days));
    const url =
      `${this.base}/api/market/candles?symbol=${encodeURIComponent(sym)}&days=${encodeURIComponent(String(d))}`;
    const res = await fetch(url);
    if (!res.ok) {
      const detail = await this.readApiError(res);
      if (res.status === 503 || res.status === 400) {
        this.candlesHttpBackoffUntil = Date.now() + this.CANDLES_HTTP_BACKOFF_MS;
      }
      throw new Error(
        'No chart data: ' +
          detail +
          ' — on the API `.env`: TWELVE_DATA_API_KEY and/or ALPHA_VANTAGE_API_KEY for charts; FINNHUB_API_KEY for quotes.'
      );
    }
    const data = (await res.json()) as DailyCandles;
    if (!data.t?.length || !data.c?.length || data.c.length < 2) {
      throw new Error('No chart data: empty series');
    }
    this.dailyCandlesCache.set(cacheKey, { ts: Date.now(), data });
    return data;
  }
}
