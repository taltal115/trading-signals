import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';

export type MarketQuoteTick = {
  symbol: string;
  price: number;
  /** Event time from Massive/Polygon (ms epoch), when present. */
  tsMs: number;
  /** Starter plan uses the delayed cluster (~15m). */
  delayed: true;
  /** Aggregate channel used for this tick. */
  channel: 'AM';
};

type QuoteListener = (tick: MarketQuoteTick) => void;

/**
 * Single upstream WebSocket to Massive/Polygon delayed stocks cluster.
 * Stocks Starter (~$29): delayed AM (per-minute aggregates) only — not trades (T.).
 * Clients never see the API key; Nest refcounts symbols across Socket.IO clients.
 */
@Injectable()
export class PolygonWsHub implements OnModuleDestroy {
  private readonly logger = new Logger(PolygonWsHub.name);
  private readonly apiKey: string;
  private readonly url: string;
  /** Prefer AM (minute) over A (second) to stay light on Starter bandwidth. */
  private readonly channelPrefix = 'AM';

  private ws: WebSocket | null = null;
  private authOk = false;
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly refCounts = new Map<string, number>();
  private readonly lastBySymbol = new Map<string, MarketQuoteTick>();
  private readonly listeners = new Set<QuoteListener>();

  constructor(private readonly config: ConfigService) {
    this.apiKey = (this.config.get<string>('polygonApiKey') || '').trim();
    // Delayed cluster for Stocks Starter (15-minute delayed). Real-time requires Advanced+.
    this.url = (
      process.env.POLYGON_WS_URL ||
      process.env.MASSIVE_WS_URL ||
      'wss://delayed.polygon.io/stocks'
    ).trim();
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  getLast(symbol: string): MarketQuoteTick | undefined {
    return this.lastBySymbol.get(this.norm(symbol));
  }

  addListener(fn: QuoteListener): void {
    this.listeners.add(fn);
  }

  removeListener(fn: QuoteListener): void {
    this.listeners.delete(fn);
  }

  /**
   * Replace one client's desired set: release old symbols, acquire new ones.
   * Returns the normalized unique symbols that remain subscribed for that client.
   */
  replaceClientSymbols(prev: ReadonlySet<string>, nextRaw: string[]): Set<string> {
    const next = new Set<string>();
    for (const s of nextRaw) {
      const n = this.norm(s);
      if (n) next.add(n);
    }
    const toRelease: string[] = [];
    for (const s of prev) {
      if (!next.has(s)) toRelease.push(s);
    }
    const toAcquire: string[] = [];
    for (const s of next) {
      if (!prev.has(s)) toAcquire.push(s);
    }
    this.releaseMany(toRelease);
    this.acquireMany(toAcquire);
    return next;
  }

  releaseAll(symbols: ReadonlySet<string>): void {
    this.releaseMany([...symbols]);
  }

  onModuleDestroy(): void {
    this.intentionalClose = true;
    this.clearReconnect();
    this.closeSocket();
  }

  private norm(s: string): string {
    return String(s || '')
      .trim()
      .toUpperCase();
  }

  private topic(symbol: string): string {
    return `${this.channelPrefix}.${symbol}`;
  }

  private acquireMany(symbols: string[]): void {
    if (!symbols.length) return;
    if (!this.configured) {
      this.logger.warn('POLYGON_API_KEY unset — live WS hub idle');
      return;
    }
    const newly: string[] = [];
    for (const sym of symbols) {
      const cur = this.refCounts.get(sym) || 0;
      this.refCounts.set(sym, cur + 1);
      if (cur === 0) newly.push(sym);
    }
    this.ensureConnected();
    if (newly.length && this.authOk) {
      this.sendSubscribe(newly);
    }
  }

  private releaseMany(symbols: string[]): void {
    if (!symbols.length) return;
    const drop: string[] = [];
    for (const sym of symbols) {
      const cur = this.refCounts.get(sym) || 0;
      if (cur <= 1) {
        this.refCounts.delete(sym);
        drop.push(sym);
      } else {
        this.refCounts.set(sym, cur - 1);
      }
    }
    if (drop.length && this.authOk && this.ws?.readyState === WebSocket.OPEN) {
      this.send({ action: 'unsubscribe', params: drop.map((s) => this.topic(s)).join(',') });
    }
    if (this.refCounts.size === 0) {
      // No dashboard interest — tear down upstream to stay within plan connection hygiene.
      this.intentionalClose = true;
      this.clearReconnect();
      this.closeSocket();
      this.intentionalClose = false;
      this.authOk = false;
    }
  }

  private ensureConnected(): void {
    if (!this.configured) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.intentionalClose = false;
    this.authOk = false;
    this.logger.log(`Connecting Massive delayed WS (${this.url})`);
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      this.send({ action: 'auth', params: this.apiKey });
    });

    ws.on('message', (data) => {
      this.onMessage(String(data));
    });

    ws.on('close', (code, reason) => {
      this.authOk = false;
      this.ws = null;
      this.logger.warn(`Massive WS closed code=${code} reason=${String(reason || '')}`);
      if (!this.intentionalClose && this.refCounts.size > 0) {
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      this.logger.warn(`Massive WS error: ${err?.message || err}`);
    });
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = Math.min(30_000, 1000 * Math.pow(2, this.reconnectAttempt++));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.refCounts.size > 0) this.ensureConnected();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private sendSubscribe(symbols: string[]): void {
    if (!symbols.length) return;
    this.send({
      action: 'subscribe',
      params: symbols.map((s) => this.topic(s)).join(','),
    });
  }

  private resubscribeAll(): void {
    const all = [...this.refCounts.keys()];
    if (all.length) this.sendSubscribe(all);
  }

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const msgs = Array.isArray(parsed) ? parsed : [parsed];
    for (const m of msgs) {
      if (!m || typeof m !== 'object') continue;
      const row = m as Record<string, unknown>;
      const ev = String(row['ev'] || '');
      if (ev === 'status') {
        const status = String(row['status'] || '');
        const message = String(row['message'] || '');
        if (status === 'auth_success' || /authenticated/i.test(message)) {
          this.authOk = true;
          this.reconnectAttempt = 0;
          this.logger.log('Massive WS authenticated (delayed AM)');
          this.resubscribeAll();
        } else if (status === 'auth_failed' || /not authorized|auth.*fail/i.test(message + status)) {
          this.logger.error(`Massive WS auth failed: ${message || status}`);
        }
        continue;
      }
      if (ev !== 'AM' && ev !== 'A') continue;
      const sym = this.norm(String(row['sym'] || ''));
      if (!sym || !this.refCounts.has(sym)) continue;
      const price = Number(row['c'] ?? row['p']);
      if (!Number.isFinite(price) || price <= 0) continue;
      const tsMs = Number(row['e'] ?? row['s'] ?? row['t'] ?? Date.now());
      const tick: MarketQuoteTick = {
        symbol: sym,
        price,
        tsMs: Number.isFinite(tsMs) ? tsMs : Date.now(),
        delayed: true,
        channel: 'AM',
      };
      this.lastBySymbol.set(sym, tick);
      for (const fn of this.listeners) {
        try {
          fn(tick);
        } catch (e) {
          this.logger.warn(`quote listener error: ${e}`);
        }
      }
    }
  }
}
