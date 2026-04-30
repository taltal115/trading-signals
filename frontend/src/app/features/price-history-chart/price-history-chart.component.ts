import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MarketDataService } from '../../core/market-data.service';
import { drawPriceChart, ChartPoint } from '../../core/chart.util';
import { fmtUsd, fmtUiPercent } from '../../core/positions-logic';

@Component({
  selector: 'app-price-history-chart',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './price-history-chart.component.html',
  styleUrl: './price-history-chart.component.css',
})
export class PriceHistoryChartComponent implements AfterViewInit, OnChanges, OnDestroy {
  private readonly market = inject(MarketDataService);

  @Input({ required: true }) ticker!: string;
  @Input({ required: true }) entryPrice!: number;
  @Input() buyDateStr = '';

  @ViewChild('canvasEl') canvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('tipEl') tipRef?: ElementRef<HTMLDivElement>;

  errorMsg = '';
  private viewReady = false;
  private points: ChartPoint[] = [];
  private moveListener?: (e: MouseEvent) => void;
  private leaveListener?: () => void;
  private ro?: ResizeObserver;
  private resizeDebounce?: ReturnType<typeof setTimeout>;

  tipVisible = false;
  tipX = 0;
  tipY = 0;
  tipDate = '';
  tipPrice = '';
  tipPnl = '';
  tipPnlClass = '';

  ngAfterViewInit(): void {
    this.viewReady = true;
    const canvas = this.canvasRef?.nativeElement;
    if (canvas?.parentElement) {
      this.ro = new ResizeObserver(() => {
        clearTimeout(this.resizeDebounce);
        this.resizeDebounce = setTimeout(() => void this.load(), 450);
      });
      this.ro.observe(canvas.parentElement);
    }
    void this.load();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this.viewReady && (changes['ticker'] || changes['entryPrice'] || changes['buyDateStr'])) {
      void this.load();
    }
  }

  ngOnDestroy(): void {
    clearTimeout(this.resizeDebounce);
    this.detachCanvasListeners();
    this.ro?.disconnect();
  }

  private detachCanvasListeners(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (canvas && this.moveListener) canvas.removeEventListener('mousemove', this.moveListener);
    if (canvas && this.leaveListener) canvas.removeEventListener('mouseleave', this.leaveListener);
    this.moveListener = undefined;
    this.leaveListener = undefined;
  }

  private async load(): Promise<void> {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    this.errorMsg = '';
    this.detachCanvasListeners();
    this.tipVisible = false;
    const sym = String(this.ticker || '').trim().toUpperCase();
    if (!sym) {
      this.errorMsg = 'Missing ticker';
      return;
    }
    const entry = Number(this.entryPrice);
    try {
      const candles = await this.market.fetchDailyCandles(sym, 20);
      const buyDateTs = this.buyDateStr ? new Date(this.buyDateStr).getTime() : null;
      const { points } = drawPriceChart(canvas, candles, entry, buyDateTs);
      this.points = points;

      this.moveListener = (e: MouseEvent) => this.onMouseMove(e, canvas);
      this.leaveListener = () => {
        this.tipVisible = false;
      };
      canvas.addEventListener('mousemove', this.moveListener);
      canvas.addEventListener('mouseleave', this.leaveListener);
    } catch (err) {
      this.errorMsg = err instanceof Error ? err.message : String(err);
    }
  }

  private onMouseMove(e: MouseEvent, canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let closest: ChartPoint | null = null;
    let closestDist = Infinity;
    for (const p of this.points) {
      const dx = p.x - mx;
      const dy = p.y - my;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist && dist < 30) {
        closestDist = dist;
        closest = p;
      }
    }
    const tip = this.tipRef?.nativeElement;
    if (closest && tip) {
      const entry = Number(this.entryPrice);
      const dateStr = closest.date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      const pnl = entry > 0 ? ((closest.price - entry) / entry) * 100 : 0;
      const pnlStr = (pnl >= 0 ? '+' : '') + fmtUiPercent(pnl) + '%';
      this.tipDate = dateStr;
      this.tipPrice = fmtUsd(closest.price);
      this.tipPnl = pnlStr;
      this.tipPnlClass = pnl > 0 ? 'tip-profit' : pnl < 0 ? 'tip-loss' : '';

      let tipX = closest.x + 10;
      let tipY = closest.y - 10;
      if (tipX + 100 > rect.width) tipX = closest.x - 110;
      if (tipY < 10) tipY = closest.y + 20;
      this.tipX = tipX;
      this.tipY = tipY;
      this.tipVisible = true;
    } else {
      this.tipVisible = false;
    }
  }
}
