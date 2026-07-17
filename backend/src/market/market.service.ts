import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface DailyCandlesDto {
  t: number[];
  c: number[];
  o: number[];
}

export type CandleProviderId = 'twelve_data' | 'alpha_vantage' | 'finnhub';

/** Hourly OHLC candles with which upstream provider succeeded. */
export interface HourlyCandlesDto {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  provider: CandleProviderId;
}

/** Combined Finnhub quote + company profile for UI “stock details”. */
export interface StockSnapshotDto {
  symbol: string;
  name: string | null;
  currency: string | null;
  exchange: string | null;
  country: string | null;
  industry: string | null;
  ipo: string | null;
  weburl: string | null;
  /** Finnhub reports market cap in millions of listing currency. */
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
    /** Unix seconds */
    time: number | null;
  };
}

type FinnhubQuoteJson = {
  c?: number;
  d?: number;
  dp?: number;
  h?: number;
  l?: number;
  o?: number;
  pc?: number;
  t?: number;
};

const FINNHUB_KEY_MISSING_MSG =
  'FINNHUB_API_KEY is not set on the API server. Set it on Cloud Run (service → Variables & secrets), e.g. gcloud run services update … --update-env-vars=FINNHUB_API_KEY=…. See docs/deploy-api-cloud-run.md.';

const FINNHUB_CANDLES_BLOCKED_MSG =
  'Daily candles: Finnhub free tier blocks stock/candle (403). Set TWELVE_DATA_API_KEY and/or ALPHA_VANTAGE_API_KEY on Cloud Run (same as local .env). Charts use those providers first. See docs/deploy-api-cloud-run.md.';

@Injectable()
export class MarketService implements OnModuleInit {
  private readonly logger = new Logger(MarketService.name);
  private finnhubMutex: Promise<void> = Promise.resolve();
  private finnhubLastDone = 0;
  private readonly FINNHUB_MIN_GAP_MS = 1200;
  private alphaVantageMutex: Promise<void> = Promise.resolve();
  private alphaVantageLastDone = 0;
  private readonly ALPHA_VANTAGE_MIN_GAP_MS = 1300;
  /** After Finnhub `stock/candle` returns 403, skip further Finnhub candle calls for a while (plan / entitlement). */
  private finnhubCandlesCircuitOpenUntil = 0;
  private readonly FINNHUB_CANDLES_COOLDOWN_MS = 30 * 60 * 1000;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    if (!this.marketDataEnabled) {
      this.logger.log('Market data disabled (MARKET_DATA_ENABLED=false); /api/market/* returns 503.');
      return;
    }
    this.logger.log(
      `Candle/quote keys loaded: finnhub=${this.maskConfigured(this.finnhubKey)} ` +
        `twelveData=${this.maskConfigured(this.twelveKey)} ` +
        `alphaVantage=${this.maskConfigured(this.alphaKey)}`
    );
  }

  private get marketDataEnabled(): boolean {
    return this.config.get<boolean>('marketDataEnabled') !== false;
  }

  private disabledError(): ServiceUnavailableException {
    return new ServiceUnavailableException(
      'Market data is disabled on this server (MARKET_DATA_ENABLED=false).'
    );
  }

  private maskConfigured(key: string): string {
    return key ? 'yes' : 'no';
  }

  private get finnhubKey(): string {
    return (this.config.get<string>('finnhubApiKey') || '').trim();
  }

  private get twelveKey(): string {
    return (this.config.get<string>('twelveDataApiKey') || '').trim();
  }

  private get alphaKey(): string {
    return (this.config.get<string>('alphaVantageApiKey') || '').trim();
  }

  private runAlphaVantageExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.alphaVantageMutex.then(async () => {
      const gap = this.ALPHA_VANTAGE_MIN_GAP_MS - (Date.now() - this.alphaVantageLastDone);
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      try {
        return await fn();
      } finally {
        this.alphaVantageLastDone = Date.now();
      }
    });
    this.alphaVantageMutex = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Serialize Finnhub calls (free tier + dashboard fan-out). */
  private runFinnhubExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.finnhubMutex.then(async () => {
      const gap = this.FINNHUB_MIN_GAP_MS - (Date.now() - this.finnhubLastDone);
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      try {
        return await fn();
      } finally {
        this.finnhubLastDone = Date.now();
      }
    });
    this.finnhubMutex = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async finnhubFetchQuoteJson(sym: string): Promise<FinnhubQuoteJson> {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${this.finnhubKey}`;
    const res = await fetch(url);
    if (res.status === 429) {
      throw new ServiceUnavailableException('Finnhub rate limited');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.warn(`Finnhub quote ${res.status} ${sym} ${body.slice(0, 120)}`);
      throw new ServiceUnavailableException(`Finnhub quote HTTP ${res.status}`);
    }
    return (await res.json()) as FinnhubQuoteJson;
  }

  async getQuote(symbol: string): Promise<number> {
    if (!this.marketDataEnabled) throw this.disabledError();
    const sym = String(symbol || '')
      .trim()
      .toUpperCase();
    if (!sym) throw new BadRequestException('Missing symbol');
    if (!this.finnhubKey) {
      throw new ServiceUnavailableException(FINNHUB_KEY_MISSING_MSG);
    }

    return this.runFinnhubExclusive(async () => {
      const data = await this.finnhubFetchQuoteJson(sym);
      if (data.c == null || data.c === 0) {
        throw new BadRequestException('No price data for symbol');
      }
      return data.c;
    });
  }

  async getStockSnapshot(symbol: string): Promise<StockSnapshotDto> {
    if (!this.marketDataEnabled) throw this.disabledError();
    const sym = String(symbol || '')
      .trim()
      .toUpperCase();
    if (!sym) throw new BadRequestException('Missing symbol');
    if (!this.finnhubKey) {
      throw new ServiceUnavailableException(FINNHUB_KEY_MISSING_MSG);
    }

    return this.runFinnhubExclusive(async () => {
      const q = await this.finnhubFetchQuoteJson(sym);
      let name: string | null = null;
      let currency: string | null = null;
      let exchange: string | null = null;
      let country: string | null = null;
      let industry: string | null = null;
      let ipo: string | null = null;
      let weburl: string | null = null;
      let marketCapitalizationMillions: number | null = null;
      let shareOutstanding: number | null = null;

      const profUrl = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(sym)}&token=${this.finnhubKey}`;
      const pres = await fetch(profUrl);
      if (pres.ok) {
        const p = (await pres.json()) as Record<string, unknown>;
        name = p['name'] != null ? String(p['name']) : null;
        currency = p['currency'] != null ? String(p['currency']) : null;
        exchange = p['exchange'] != null ? String(p['exchange']) : null;
        country = p['country'] != null ? String(p['country']) : null;
        industry = p['finnhubIndustry'] != null ? String(p['finnhubIndustry']) : null;
        ipo = p['ipo'] != null ? String(p['ipo']) : null;
        weburl = p['weburl'] != null ? String(p['weburl']) : null;
        const mc = p['marketCapitalization'];
        if (mc != null && Number.isFinite(Number(mc))) {
          marketCapitalizationMillions = Number(mc);
        }
        const so = p['shareOutstanding'];
        if (so != null && Number.isFinite(Number(so))) {
          shareOutstanding = Number(so);
        }
      } else {
        const body = await pres.text().catch(() => '');
        this.logger.warn(`Finnhub profile2 ${pres.status} ${sym} ${body.slice(0, 80)}`);
      }

      return {
        symbol: sym,
        name,
        currency,
        exchange,
        country,
        industry,
        ipo,
        weburl,
        marketCapitalizationMillions,
        shareOutstanding,
        quote: {
          current: q.c != null && Number.isFinite(Number(q.c)) ? Number(q.c) : null,
          change: q.d != null && Number.isFinite(Number(q.d)) ? Number(q.d) : null,
          pctChange: q.dp != null && Number.isFinite(Number(q.dp)) ? Number(q.dp) : null,
          high: q.h != null && Number.isFinite(Number(q.h)) ? Number(q.h) : null,
          low: q.l != null && Number.isFinite(Number(q.l)) ? Number(q.l) : null,
          open: q.o != null && Number.isFinite(Number(q.o)) ? Number(q.o) : null,
          prevClose: q.pc != null && Number.isFinite(Number(q.pc)) ? Number(q.pc) : null,
          time: q.t != null && Number.isFinite(Number(q.t)) ? Number(q.t) : null,
        },
      };
    });
  }

  private async candlesTwelveData(symbol: string, days: number): Promise<DailyCandlesDto> {
    const key = this.twelveKey;
    if (!key) throw new Error('no twelve data key');
    const n = Math.min(Math.max(days, 5), 5000);
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${n}&apikey=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Twelve Data HTTP ' + res.status);
    const data = (await res.json()) as {
      status?: string;
      code?: number;
      message?: string;
      values?: { datetime?: string; close?: string; open?: string }[];
    };
    if (data.status === 'error' || data.code === 401 || data.code === 403) {
      throw new Error('Twelve Data: ' + (data.message || 'error' + (data.code ? ` (${data.code})` : '')));
    }
    const values = data.values;
    if (!values?.length) throw new Error('Twelve Data: no values');
    const slice = values.slice(0, n).reverse();
    const t: number[] = [];
    const c: number[] = [];
    const o: number[] = [];
    for (const row of slice) {
      const ds = String(row.datetime || '')
        .trim()
        .split(' ')[0];
      t.push(Math.floor(new Date(ds + 'T12:00:00Z').getTime() / 1000));
      c.push(parseFloat(String(row.close)));
      o.push(parseFloat(String(row.open)));
    }
    return { t, c, o };
  }

  private async candlesAlphaVantage(symbol: string, days: number): Promise<DailyCandlesDto> {
    const key = this.alphaKey;
    if (!key) throw new Error('no Alpha Vantage key');
    const want = Math.min(500, Math.max(days + 25, 5));
    const outputsize = want > 100 ? 'full' : 'compact';

    return this.runAlphaVantageExclusive(async () => {
      const url =
        `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY` +
        `&symbol=${encodeURIComponent(symbol)}&outputsize=${outputsize}` +
        `&apikey=${encodeURIComponent(key)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Alpha Vantage HTTP ' + res.status);
      const data = (await res.json()) as Record<string, unknown>;
      const errMsg = data['Error Message'];
      if (typeof errMsg === 'string') throw new Error('Alpha Vantage: ' + errMsg.slice(0, 200));
      const note = data['Note'] ?? data['Information'];
      if (typeof note === 'string') throw new Error('Alpha Vantage: ' + note.slice(0, 200));
      const series = data['Time Series (Daily)'] as
        | Record<string, { '1. open'?: string; '4. close'?: string }>
        | undefined;
      if (!series || typeof series !== 'object') {
        throw new Error('Alpha Vantage: no Time Series (Daily)');
      }
      const dates = Object.keys(series).sort();
      if (dates.length < 2) throw new Error('Alpha Vantage: not enough history');
      const takeDates = dates.slice(-Math.min(want, dates.length));
      const t: number[] = [];
      const c: number[] = [];
      const o: number[] = [];
      for (const ds of takeDates) {
        const row = series[ds];
        const close = parseFloat(String(row?.['4. close'] ?? ''));
        const open = parseFloat(String(row?.['1. open'] ?? row?.['4. close'] ?? ''));
        if (!Number.isFinite(close)) continue;
        t.push(Math.floor(new Date(ds + 'T12:00:00Z').getTime() / 1000));
        c.push(close);
        o.push(Number.isFinite(open) ? open : close);
      }
      if (c.length < 2) throw new Error('Alpha Vantage: not enough parsed bars');
      const take = Math.min(days, t.length);
      const start = Math.max(0, t.length - take);
      return { t: t.slice(start), c: c.slice(start), o: o.slice(start) };
    });
  }

  private finnhubCandlesCircuitError(): ServiceUnavailableException {
    return new ServiceUnavailableException(FINNHUB_CANDLES_BLOCKED_MSG);
  }

  private async candlesFinnhub(symbol: string, days: number): Promise<DailyCandlesDto> {
    if (!this.finnhubKey) {
      throw new ServiceUnavailableException(FINNHUB_KEY_MISSING_MSG);
    }
    if (Date.now() < this.finnhubCandlesCircuitOpenUntil) {
      throw this.finnhubCandlesCircuitError();
    }
    return this.runFinnhubExclusive(async () => {
      if (Date.now() < this.finnhubCandlesCircuitOpenUntil) {
        throw this.finnhubCandlesCircuitError();
      }
      const to = Math.floor(Date.now() / 1000);
      const from = to - (days + 20) * 86400;
      const url =
        `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}` +
        `&resolution=D&from=${from}&to=${to}&token=${this.finnhubKey}`;
      const res = await fetch(url);
      if (res.status === 429) {
        throw new ServiceUnavailableException('Finnhub rate limited');
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 403) {
          const wasClosed = Date.now() >= this.finnhubCandlesCircuitOpenUntil;
          this.finnhubCandlesCircuitOpenUntil = Date.now() + this.FINNHUB_CANDLES_COOLDOWN_MS;
          if (wasClosed) {
            this.logger.warn(
              'Finnhub stock/candle returned 403 (no access on this plan). ' +
                `Cooling down ${this.FINNHUB_CANDLES_COOLDOWN_MS / 60000}m; set TWELVE_DATA_API_KEY for daily candles.`
            );
          }
        } else {
          this.logger.warn(`Finnhub candle ${res.status} ${symbol} ${body.slice(0, 120)}`);
        }
        throw new ServiceUnavailableException(
          res.status === 403
            ? 'Finnhub candle access denied (403)'
            : `Finnhub candle HTTP ${res.status}`
        );
      }
      const data = (await res.json()) as {
        s?: string;
        t?: number[];
        c?: number[];
        o?: number[];
      };
      if (data.s === 'no_data' || !data.t?.length || !data.c?.length) {
        throw new BadRequestException('No daily candle data for symbol');
      }
      const t = data.t;
      const c = data.c;
      const o = data.o && data.o.length === c.length ? data.o : c;
      const take = Math.min(days, t.length);
      const start = Math.max(0, t.length - take);
      return {
        t: t.slice(start),
        c: c.slice(start),
        o: o.slice(start),
      };
    });
  }

  async getDailyCandles(symbol: string, days: number): Promise<DailyCandlesDto> {
    if (!this.marketDataEnabled) throw this.disabledError();
    const sym = String(symbol || '')
      .trim()
      .toUpperCase();
    if (!sym) throw new BadRequestException('Missing symbol');
    const d = Math.min(500, Math.max(2, days));

    if (this.twelveKey) {
      try {
        const fromTd = await this.candlesTwelveData(sym, d);
        if (fromTd.c.length >= 2) return fromTd;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Twelve Data candles failed for ${sym}: ${msg}`);
      }
    }

    if (this.alphaKey) {
      try {
        const fromAv = await this.candlesAlphaVantage(sym, d);
        if (fromAv.c.length >= 2) return fromAv;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Alpha Vantage candles failed for ${sym}: ${msg}`);
      }
    }

    const fromFh = await this.candlesFinnhub(sym, d);
    if (fromFh.c.length < 2) {
      throw new BadRequestException('Not enough candle history');
    }
    return fromFh;
  }

  private static readonly MAX_HOURLY_SPAN_SEC = 10 * 86400;

  private async hourlyTwelveData(
    symbol: string,
    fromSec: number,
    toSec: number
  ): Promise<HourlyCandlesDto> {
    const key = this.twelveKey;
    if (!key) throw new Error('no twelve data key');
    const start = new Date(fromSec * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const end = new Date(toSec * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const url =
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
      `&interval=1h&start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}` +
      `&timezone=UTC&apikey=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Twelve Data HTTP ' + res.status);
    const data = (await res.json()) as {
      status?: string;
      code?: number;
      message?: string;
      values?: {
        datetime?: string;
        open?: string;
        high?: string;
        low?: string;
        close?: string;
      }[];
    };
    if (data.status === 'error' || data.code === 401 || data.code === 403) {
      throw new Error('Twelve Data: ' + (data.message || 'error' + (data.code ? ` (${data.code})` : '')));
    }
    const values = data.values;
    if (!values?.length) throw new Error('Twelve Data: no hourly values');
    const chronological = [...values].reverse();
    const t: number[] = [];
    const o: number[] = [];
    const h: number[] = [];
    const l: number[] = [];
    const c: number[] = [];
    for (const row of chronological) {
      const ds = String(row.datetime || '').trim();
      if (!ds) continue;
      const iso = ds.includes('T') ? ds : ds.replace(' ', 'T');
      const withZ = /Z$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
      const ts = Math.floor(new Date(withZ).getTime() / 1000);
      if (!Number.isFinite(ts) || ts < fromSec || ts > toSec) continue;
      const open = parseFloat(String(row.open ?? ''));
      const high = parseFloat(String(row.high ?? ''));
      const low = parseFloat(String(row.low ?? ''));
      const close = parseFloat(String(row.close ?? ''));
      if (!Number.isFinite(close)) continue;
      t.push(ts);
      o.push(Number.isFinite(open) ? open : close);
      h.push(Number.isFinite(high) ? high : close);
      l.push(Number.isFinite(low) ? low : close);
      c.push(close);
    }
    if (c.length < 2) throw new Error('Twelve Data: not enough hourly bars in window');
    return { t, o, h, l, c, provider: 'twelve_data' };
  }

  private async hourlyAlphaVantage(
    symbol: string,
    fromSec: number,
    toSec: number
  ): Promise<HourlyCandlesDto> {
    const key = this.alphaKey;
    if (!key) throw new Error('no Alpha Vantage key');

    return this.runAlphaVantageExclusive(async () => {
      const url =
        `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY` +
        `&symbol=${encodeURIComponent(symbol)}&interval=60min&outputsize=full` +
        `&apikey=${encodeURIComponent(key)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Alpha Vantage HTTP ' + res.status);
      const data = (await res.json()) as Record<string, unknown>;
      const errMsg = data['Error Message'];
      if (typeof errMsg === 'string') throw new Error('Alpha Vantage: ' + errMsg.slice(0, 200));
      const note = data['Note'] ?? data['Information'];
      if (typeof note === 'string') throw new Error('Alpha Vantage: ' + note.slice(0, 200));
      const series = data['Time Series (60min)'] as
        | Record<
            string,
            { '1. open'?: string; '2. high'?: string; '3. low'?: string; '4. close'?: string }
          >
        | undefined;
      if (!series || typeof series !== 'object') {
        throw new Error('Alpha Vantage: no Time Series (60min)');
      }
      const keys = Object.keys(series).sort();
      const t: number[] = [];
      const o: number[] = [];
      const h: number[] = [];
      const l: number[] = [];
      const c: number[] = [];
      for (const ds of keys) {
        const ts = Math.floor(new Date(ds.includes('T') ? ds : ds.replace(' ', 'T')).getTime() / 1000);
        if (!Number.isFinite(ts) || ts < fromSec || ts > toSec) continue;
        const row = series[ds];
        const close = parseFloat(String(row?.['4. close'] ?? ''));
        if (!Number.isFinite(close)) continue;
        const open = parseFloat(String(row?.['1. open'] ?? ''));
        const high = parseFloat(String(row?.['2. high'] ?? ''));
        const low = parseFloat(String(row?.['3. low'] ?? ''));
        t.push(ts);
        o.push(Number.isFinite(open) ? open : close);
        h.push(Number.isFinite(high) ? high : close);
        l.push(Number.isFinite(low) ? low : close);
        c.push(close);
      }
      if (c.length < 2) throw new Error('Alpha Vantage: not enough hourly bars in window');
      return { t, o, h, l, c, provider: 'alpha_vantage' };
    });
  }

  private async hourlyFinnhub(
    symbol: string,
    fromSec: number,
    toSec: number
  ): Promise<HourlyCandlesDto> {
    if (!this.finnhubKey) {
      throw new ServiceUnavailableException(FINNHUB_KEY_MISSING_MSG);
    }
    if (Date.now() < this.finnhubCandlesCircuitOpenUntil) {
      throw this.finnhubCandlesCircuitError();
    }
    return this.runFinnhubExclusive(async () => {
      if (Date.now() < this.finnhubCandlesCircuitOpenUntil) {
        throw this.finnhubCandlesCircuitError();
      }
      const url =
        `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}` +
        `&resolution=60&from=${fromSec}&to=${toSec}&token=${this.finnhubKey}`;
      const res = await fetch(url);
      if (res.status === 429) {
        throw new ServiceUnavailableException('Finnhub rate limited');
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 403) {
          const wasClosed = Date.now() >= this.finnhubCandlesCircuitOpenUntil;
          this.finnhubCandlesCircuitOpenUntil = Date.now() + this.FINNHUB_CANDLES_COOLDOWN_MS;
          if (wasClosed) {
            this.logger.warn(
              'Finnhub stock/candle returned 403 (no access on this plan). ' +
                `Cooling down ${this.FINNHUB_CANDLES_COOLDOWN_MS / 60000}m; set TWELVE_DATA_API_KEY for candles.`
            );
          }
        } else {
          this.logger.warn(`Finnhub hourly candle ${res.status} ${symbol} ${body.slice(0, 120)}`);
        }
        throw new ServiceUnavailableException(
          res.status === 403
            ? 'Finnhub candle access denied (403)'
            : `Finnhub candle HTTP ${res.status}`
        );
      }
      const data = (await res.json()) as {
        s?: string;
        t?: number[];
        o?: number[];
        h?: number[];
        l?: number[];
        c?: number[];
      };
      if (data.s === 'no_data' || !data.t?.length || !data.c?.length) {
        throw new BadRequestException('No hourly candle data for symbol');
      }
      const t: number[] = [];
      const o: number[] = [];
      const h: number[] = [];
      const l: number[] = [];
      const c: number[] = [];
      for (let i = 0; i < data.t.length; i++) {
        const ts = data.t[i];
        if (ts < fromSec || ts > toSec) continue;
        const close = data.c[i];
        if (close == null || !Number.isFinite(close)) continue;
        t.push(ts);
        o.push(data.o?.[i] != null && Number.isFinite(data.o[i]) ? data.o[i] : close);
        h.push(data.h?.[i] != null && Number.isFinite(data.h[i]) ? data.h[i] : close);
        l.push(data.l?.[i] != null && Number.isFinite(data.l[i]) ? data.l[i] : close);
        c.push(close);
      }
      if (c.length < 2) throw new BadRequestException('Not enough hourly bars in window');
      return { t, o, h, l, c, provider: 'finnhub' };
    });
  }

  async getHourlyCandles(symbol: string, fromSec: number, toSec: number): Promise<HourlyCandlesDto> {
    if (!this.marketDataEnabled) throw this.disabledError();
    const sym = String(symbol || '')
      .trim()
      .toUpperCase();
    if (!sym) throw new BadRequestException('Missing symbol');
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) {
      throw new BadRequestException('from and to must be unix seconds');
    }
    if (toSec <= fromSec) {
      throw new BadRequestException('to must be greater than from');
    }
    if (toSec - fromSec > MarketService.MAX_HOURLY_SPAN_SEC) {
      throw new BadRequestException('Hourly window too large (max 10 calendar days)');
    }

    if (this.twelveKey) {
      try {
        const fromTd = await this.hourlyTwelveData(sym, fromSec, toSec);
        if (fromTd.c.length >= 2) return fromTd;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Twelve Data hourly candles failed for ${sym}: ${msg}`);
      }
    }

    if (this.alphaKey) {
      try {
        const fromAv = await this.hourlyAlphaVantage(sym, fromSec, toSec);
        if (fromAv.c.length >= 2) return fromAv;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Alpha Vantage hourly candles failed for ${sym}: ${msg}`);
      }
    }

    return this.hourlyFinnhub(sym, fromSec, toSec);
  }
}
