import { AfterViewInit, Component, ElementRef, Input, ViewChild } from '@angular/core';
import { isProviderQuotaError, MarketDataService } from '../../core/market-data.service';
import { drawMiniPriceChart } from '../../core/chart.util';

@Component({
  selector: 'app-dashboard-mini-chart',
  standalone: true,
  templateUrl: './dashboard-mini-chart.component.html',
  styleUrl: './dashboard-mini-chart.component.css',
})
export class DashboardMiniChartComponent implements AfterViewInit {
  @Input({ required: true }) ticker!: string;
  @Input() entryPrice = 0;
  @Input() boughtAt: string | null = null;

  @ViewChild('cv') cv?: ElementRef<HTMLCanvasElement>;

  constructor(private readonly market: MarketDataService) {}

  async ngAfterViewInit(): Promise<void> {
    const canvas = this.cv?.nativeElement;
    if (!canvas || !this.ticker) return;
    try {
      const candles = await this.market.fetchDailyCandles(this.ticker, 15);
      const buyTs = this.boughtAt ? new Date(this.boughtAt).getTime() : null;
      drawMiniPriceChart(canvas, candles, this.entryPrice, buyTs);
    } catch (e) {
      if (!isProviderQuotaError(e)) {
        console.debug('mini chart', this.ticker, e);
      }
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        ctx.fillStyle = 'rgba(128,128,128,0.5)';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Chart unavailable', rect.width / 2, rect.height / 2);
      }
    }
  }
}
