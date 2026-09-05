import { Module } from '@nestjs/common';
import { MarketController } from './market.controller';
import { MarketService } from './market.service';
import { MarketQuotesGateway } from './market-quotes.gateway';
import { PolygonWsHub } from './polygon-ws.hub';

@Module({
  controllers: [MarketController],
  providers: [MarketService, PolygonWsHub, MarketQuotesGateway],
  exports: [MarketService],
})
export class MarketModule {}
