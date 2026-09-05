import { Injectable, OnDestroy, signal } from '@angular/core';
import { io, type Socket } from 'socket.io-client';
import { environment } from '../../environments/environment';

export type LiveQuoteTick = {
  symbol: string;
  price: number;
  tsMs: number;
  delayed: boolean;
  channel?: string;
};

/**
 * Page-scoped live quotes via Nest → Massive/Polygon WebSocket hub.
 * Call `setPageSymbols` whenever the Signals table page/filter set changes;
 * empty list (or destroy) tears down the client socket so Nest can unsubscribe upstream.
 */
@Injectable({ providedIn: 'root' })
export class MarketQuotesWsService implements OnDestroy {
  private socket: Socket | null = null;
  private desired: string[] = [];

  readonly connected = signal(false);
  readonly hubConfigured = signal(true);
  /** True when hub uses delayed (~15m) cluster; false for Advanced realtime. */
  readonly delayed = signal(true);
  /** Aggregate channel from hub (`A` or `AM`). */
  readonly channel = signal('AM');
  readonly lastError = signal('');

  /** Latest numeric prices by ticker (from WS / seed). */
  readonly priceByTicker = signal<Record<string, number>>({});

  ngOnDestroy(): void {
    this.clear();
  }

  /** Replace the active subscription set (unique uppercase tickers on the current page). */
  setPageSymbols(symbols: string[]): void {
    const next: string[] = [];
    const seen = new Set<string>();
    for (const raw of symbols) {
      const s = String(raw || '')
        .trim()
        .toUpperCase();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      next.push(s);
    }
    next.sort();
    this.desired = next;

    if (!next.length) {
      this.disconnect();
      return;
    }

    this.ensureSocket();
    if (this.socket?.connected) {
      this.emitSubscriptions();
    }
  }

  clear(): void {
    this.desired = [];
    this.disconnect();
  }

  private ensureSocket(): void {
    if (this.socket) return;
    const base = (environment.apiBaseUrl || '').replace(/\/$/, '');
    // Same-origin in prod (Hosting rewrite); empty base → current origin in ng serve proxy.
    const url = base || undefined;
    const host = typeof location !== 'undefined' ? location.hostname : '';
    const behindHosting =
      host.endsWith('.web.app') || host.endsWith('.firebaseapp.com');
    // Hosting → Cloud Run rewrites HTTP, but the WebSocket upgrade fails
    // (`wss://…/api/socket.io`). Stay on polling so live quotes still work.
    const socket = io(`${url || ''}/market-quotes`, {
      path: '/api/socket.io',
      withCredentials: true,
      transports: behindHosting ? ['polling'] : ['websocket', 'polling'],
      upgrade: !behindHosting,
      rememberUpgrade: false,
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1500,
      reconnectionDelayMax: 10_000,
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.connected.set(true);
      this.lastError.set('');
      this.emitSubscriptions();
    });
    socket.on('disconnect', () => {
      this.connected.set(false);
    });
    socket.on('connect_error', (err) => {
      this.connected.set(false);
      this.lastError.set(err?.message || String(err));
    });
    socket.on(
      'hub_status',
      (payload: {
        configured?: boolean;
        delayed?: boolean;
        channel?: string;
        message?: string;
      }) => {
        this.hubConfigured.set(payload?.configured !== false);
        if (typeof payload?.delayed === 'boolean') {
          this.delayed.set(payload.delayed);
        }
        if (payload?.channel) {
          this.channel.set(String(payload.channel));
        }
        if (payload?.message && payload.configured === false) {
          this.lastError.set(payload.message);
        }
      },
    );
    socket.on('quote', (tick: LiveQuoteTick) => {
      const sym = String(tick?.symbol || '')
        .trim()
        .toUpperCase();
      const price = Number(tick?.price);
      if (!sym || !Number.isFinite(price) || price <= 0) return;
      this.priceByTicker.update((m) => ({ ...m, [sym]: price }));
    });
  }

  private emitSubscriptions(): void {
    if (!this.socket?.connected) return;
    this.socket.emit(
      'setSubscriptions',
      { symbols: this.desired },
      (_ack: { ok?: boolean; symbols?: string[] } | undefined) => {
        /* ack optional */
      },
    );
  }

  private disconnect(): void {
    if (this.socket) {
      try {
        if (this.socket.connected) {
          this.socket.emit('setSubscriptions', { symbols: [] });
        }
      } catch {
        /* ignore */
      }
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.connected.set(false);
  }
}
