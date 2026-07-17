import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
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
    @Query('days') daysRaw?: string,
    @Query('interval') intervalRaw?: string,
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string
  ) {
    const interval = String(intervalRaw || '1d').trim().toLowerCase();
    if (interval === '1h' || interval === '60' || interval === '60min') {
      const fromSec = parseInt(String(fromRaw || ''), 10);
      const toSec = parseInt(String(toRaw || ''), 10);
      if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) {
        throw new BadRequestException('Hourly candles require from and to (unix seconds)');
      }
      return this.market.getHourlyCandles(symbol, fromSec, toSec);
    }
    const days = parseInt(String(daysRaw || '20'), 10);
    const safe = Number.isFinite(days) ? days : 20;
    return this.market.getDailyCandles(symbol, safe);
  }
}
