import { Controller, Get, Query } from '@nestjs/common';
import { MarketService } from './market.service';

@Controller('market')
export class MarketController {
  constructor(private readonly market: MarketService) {}

  @Get('quote')
  async quote(@Query('symbol') symbol: string) {
    const c = await this.market.getQuote(symbol);
    return { c };
  }

  @Get('snapshot')
  async snapshot(@Query('symbol') symbol: string) {
    return this.market.getStockSnapshot(symbol);
  }

  @Get('candles')
  async candles(
    @Query('symbol') symbol: string,
    @Query('days') daysRaw?: string
  ) {
    const days = parseInt(String(daysRaw || '20'), 10);
    const safe = Number.isFinite(days) ? days : 20;
    return this.market.getDailyCandles(symbol, safe);
  }
}
