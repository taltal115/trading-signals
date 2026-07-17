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
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  MarketDataService,
  candleProviderLabel,
  isProviderQuotaError,
  type CandleProviderId,
} from '../../core/market-data.service';
import { drawHoldLineChart, lastIndexAtOrBefore, type HoldLineHit } from '../../core/hold-line-chart.util';
import { computeSignalHoldWindow } from '../../core/signal-hold-window';
import { fmtUsd } from '../../core/positions-logic';

@Component({
  selector: 'app-signal-hold-chart',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './signal-hold-chart.component.html',
  styleUrl: './signal-hold-chart.component.css',
})
export class SignalHoldChartComponent implements AfterViewInit, OnChanges, OnDestroy {
  private readonly market = inject(MarketDataService);

  @Input({ required: true }) ticker!: string;
  @Input({ required: true }) asofDate!: string;
  @Input({ required: true }) entryPrice!: number;

  @ViewChild('canvasEl') canvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('tipEl') tipRef?: ElementRef<HTMLDivElement>;

  readonly loading = signal(true);
  readonly errorMsg = signal('');
  readonly providerLabel = signal('');
  readonly progressCaption = signal('');

  tipVisible = false;
  tipX = 0;
  tipY = 0;
  tipTime = '';
  tipPrice = '';

  private viewReady = false;
  private hits: HoldLineHit[] = [];
  private moveListener?: (e: MouseEvent) => void;
  private leaveListener?: () => void;
  private ro?: ResizeObserver;
  private resizeDebounce?: ReturnType<typeof setTimeout>;
  private loadGen = 0;

  ngAfterViewInit(): void {
    this.viewReady = true;
    const canvas = this.canvasRef?.nativeElement;
    if (canvas?.parentElement) {
      this.ro = new ResizeObserver(() => {
        clearTimeout(this.resizeDebounce);
        this.resizeDebounce = setTimeout(() => void this.load(), 400);
      });
      this.ro.observe(canvas.parentElement);
    }
    void this.load();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (
      this.viewReady &&
      (changes['ticker'] || changes['asofDate'] || changes['entryPrice'])
    ) {
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
    const gen = ++this.loadGen;
    this.loading.set(true);
    this.errorMsg.set('');
    this.providerLabel.set('');
    this.progressCaption.set('');
    this.detachCanvasListeners();
    this.tipVisible = false;

    const sym = String(this.ticker || '')
      .trim()
      .toUpperCase();
    const entry = Number(this.entryPrice);
    if (!sym) {
      this.loading.set(false);
      this.errorMsg.set('Missing ticker');
      return;
    }
    if (!Number.isFinite(entry) || entry <= 0) {
      this.loading.set(false);
      this.errorMsg.set('Missing entry price');
      return;
    }

    try {
      const win = computeSignalHoldWindow(this.asofDate);
      // Include signal-day RTH (09:30) so entry is on asof_date, not next open.
      const fromSec = Math.floor(win.fetchFromMs / 1000);
      const toSec = Math.floor(win.fetchToMs / 1000);
      if (toSec <= fromSec) {
        throw new Error('Hold window has not started yet (entry is in the future)');
      }

      const candles = await this.market.fetchHourlyCandles(sym, fromSec, toSec);
      if (gen !== this.loadGen) return;

      // Drop any bars after planned exit (provider may overshoot).
      const exitCut = lastIndexAtOrBefore(candles.t, win.exitMs);
      const clipped = {
        t: candles.t.slice(0, exitCut + 1),
        o: candles.o.slice(0, exitCut + 1),
        h: candles.h.slice(0, exitCut + 1),
        l: candles.l.slice(0, exitCut + 1),
        c: candles.c.slice(0, exitCut + 1),
        provider: candles.provider,
      };
      if (clipped.c.length < 2) {
        throw new Error('Not enough hourly bars in the hold window');
      }

      const exitIdx = lastIndexAtOrBefore(clipped.t, win.exitMs);
      const exitPrice =
        !win.inProgress && clipped.c.length ? clipped.c[exitIdx] : null;

      const { hits } = drawHoldLineChart(canvas, clipped, {
        entryMs: win.entryMs,
        exitMs: win.exitMs,
        entryPrice: entry,
        exitPrice,
        inProgress: win.inProgress,
      });
      this.hits = hits;
      this.providerLabel.set(candleProviderLabel(candles.provider as CandleProviderId));
      this.progressCaption.set(
        win.inProgress
          ? '3 trading-day hold in progress (hourly closes through now)'
          : '3 trading-day hold window complete'
      );

      this.moveListener = (e: MouseEvent) => this.onMouseMove(e, canvas);
      this.leaveListener = () => {
        this.tipVisible = false;
      };
      canvas.addEventListener('mousemove', this.moveListener);
      canvas.addEventListener('mouseleave', this.leaveListener);
    } catch (err) {
      if (gen !== this.loadGen) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMsg.set(msg);
      void isProviderQuotaError(err);
    } finally {
      if (gen === this.loadGen) this.loading.set(false);
    }
  }

  private onMouseMove(e: MouseEvent, canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let closest: HoldLineHit | null = null;
    let closestDist = Infinity;
    for (const h of this.hits) {
      const dx = h.cx - mx;
      const dy = h.cy - my;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist && dist < 24) {
        closestDist = dist;
        closest = h;
      }
    }
    if (closest) {
      const d = new Date(closest.timeSec * 1000);
      this.tipTime =
        d.toLocaleString('en-US', {
          timeZone: 'America/New_York',
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }) + ' ET';
      this.tipPrice = fmtUsd(closest.price);
      this.tipX = Math.min(Math.max(8, mx + 12), rect.width - 140);
      this.tipY = Math.min(Math.max(8, my + 12), rect.height - 48);
      this.tipVisible = true;
    } else {
      this.tipVisible = false;
    }
  }
}
