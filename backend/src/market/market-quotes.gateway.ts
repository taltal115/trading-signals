import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { MarketService } from './market.service';
import { PolygonWsHub, type MarketQuoteTick } from './polygon-ws.hub';

/** Hard cap per browser tab — Signals page max per-page is 50 unique tickers. */
const MAX_SYMBOLS_PER_CLIENT = 50;

type SetSubscriptionsBody = {
  symbols?: unknown;
};

/**
 * Browser ↔ Nest multiplex for Massive delayed stock quotes.
 * Path `/api/socket.io` matches Firebase Hosting `/api/**` → Cloud Run rewrite.
 * One Nest process holds one upstream Polygon connection; clients only set page tickers.
 */
@WebSocketGateway({
  namespace: '/market-quotes',
  path: '/api/socket.io',
  cors: {
    origin: true,
    credentials: true,
  },
})
export class MarketQuotesGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(MarketQuotesGateway.name);

  @WebSocketServer()
  server!: Server;

  /** socket.id → normalized symbols currently counted in the hub for that client */
  private readonly clientSymbols = new Map<string, Set<string>>();

  private readonly onTick = (tick: MarketQuoteTick) => {
    this.broadcastTick(tick);
  };

  constructor(
    private readonly hub: PolygonWsHub,
    private readonly market: MarketService,
  ) {}

  afterInit(): void {
    this.hub.addListener(this.onTick);
    this.logger.log(
      `Market quotes WS ready (namespace=/market-quotes path=/api/socket.io hub=${
        this.hub.configured ? 'configured' : 'no POLYGON_API_KEY'
      })`,
    );
  }

  handleConnection(client: Socket): void {
    this.clientSymbols.set(client.id, new Set());
    client.emit('hub_status', {
      configured: this.hub.configured,
      delayed: true,
      channel: 'AM',
      message: this.hub.configured
        ? 'Connected — send setSubscriptions with visible page tickers'
        : 'POLYGON_API_KEY missing on API server',
    });
  }

  handleDisconnect(client: Socket): void {
    const prev = this.clientSymbols.get(client.id) || new Set();
    this.hub.releaseAll(prev);
    this.clientSymbols.delete(client.id);
  }

  @SubscribeMessage('setSubscriptions')
  async handleSetSubscriptions(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: SetSubscriptionsBody,
  ): Promise<{ ok: boolean; symbols: string[]; seeded: number }> {
    const prev = this.clientSymbols.get(client.id) || new Set();
    const raw = Array.isArray(body?.symbols) ? body.symbols : [];
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      const s = String(item || '')
        .trim()
        .toUpperCase();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      cleaned.push(s);
      if (cleaned.length >= MAX_SYMBOLS_PER_CLIENT) break;
    }

    if (!this.hub.configured) {
      this.clientSymbols.set(client.id, new Set());
      this.hub.releaseAll(prev);
      return { ok: false, symbols: [], seeded: 0 };
    }

    const next = this.hub.replaceClientSymbols(prev, cleaned);
    this.clientSymbols.set(client.id, next);

    // Seed from REST snapshot so the table is not blank until the first AM bar.
    let seeded = 0;
    const toSeed: string[] = [];
    for (const sym of next) {
      if (!prev.has(sym) && !this.hub.getLast(sym)) toSeed.push(sym);
    }
    for (const sym of toSeed) {
      try {
        const c = await this.market.getQuote(sym);
        if (c == null || !Number.isFinite(c) || c <= 0) continue;
        const tick: MarketQuoteTick = {
          symbol: sym,
          price: c,
          tsMs: Date.now(),
          delayed: true,
          channel: 'AM',
        };
        client.emit('quote', tick);
        seeded += 1;
      } catch (e) {
        this.logger.debug(`seed quote ${sym}: ${e}`);
      }
    }

    // Replay last WS ticks for symbols already streaming for other clients.
    for (const sym of next) {
      const last = this.hub.getLast(sym);
      if (last) client.emit('quote', last);
    }

    return { ok: true, symbols: [...next], seeded };
  }

  private broadcastTick(tick: MarketQuoteTick): void {
    for (const [id, symbols] of this.clientSymbols) {
      if (!symbols.has(tick.symbol)) continue;
      this.server.to(id).emit('quote', tick);
    }
  }
}
