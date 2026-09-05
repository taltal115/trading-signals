import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  AiChartHit,
  AiChartMetric,
  AiChartRow,
  drawAiBarChart,
  drawAiDonutChart,
  formatMetric,
  limitChartRows,
  metricValue,
} from '../../core/ai-analytics-chart.util';

export type AiChartVariant = 'donut' | 'vertical' | 'horizontal';

export const AI_CHART_TOP_N_OPTIONS = [8, 12, 16, 24] as const;

@Component({
  selector: 'app-ai-agg-chart',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ai-agg-chart.component.html',
  styleUrl: './ai-agg-chart.component.css',
})
export class AiAggChartComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) title = '';
  @Input() variant: AiChartVariant = 'horizontal';

  @ViewChild('canvasEl') canvasRef?: ElementRef<HTMLCanvasElement>;

  readonly metrics: AiChartMetric[] = ['requests', 'tokens', 'cost'];
  readonly topNOptions = AI_CHART_TOP_N_OPTIONS;
  readonly metric = signal<AiChartMetric>('cost');
  readonly topN = signal<number>(12);
  readonly tip = signal<{ x: number; y: number; text: string } | null>(null);
  readonly legend = signal<{ label: string; color: string; value: string }[]>([]);
  readonly rowSource = signal<AiChartRow[]>([]);

  readonly showTopN = computed(() => this.variant === 'horizontal');
  readonly displayRows = computed(() => {
    const rows = this.rowSource();
    const m = this.metric();
    return this.variant === 'horizontal' ? limitChartRows(rows, this.topN(), m) : rows;
  });

  @Input({ required: true })
  set rows(value: AiChartRow[]) {
    this.rowSource.set(value || []);
  }

  private ro: ResizeObserver | null = null;
  private hits: AiChartHit[] = [];
  private viewReady = false;

  constructor() {
    effect(() => {
      this.displayRows();
      this.metric();
      this.topN();
      if (this.viewReady) queueMicrotask(() => this.redraw());
    });
  }

  ngAfterViewInit(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    this.viewReady = true;
    this.ro = new ResizeObserver(() => this.redraw());
    this.ro.observe(canvas.parentElement || canvas);
    this.redraw();
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
  }

  setMetric(m: AiChartMetric): void {
    this.metric.set(m);
    this.redraw();
  }

  onTopNChange(raw: string): void {
    const n = Number(raw);
    if (!Number.isFinite(n) || n === this.topN()) return;
    this.topN.set(n);
    this.redraw();
  }

  onMove(ev: MouseEvent): void {
    const wrap = ev.currentTarget as HTMLElement;
    const rect = wrap.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const hit = this.hits.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
    if (!hit) {
      this.tip.set(null);
      return;
    }
    this.tip.set({
      x: Math.min(x + 12, rect.width - 140),
      y: Math.max(8, y - 28),
      text: `${hit.label} · ${hit.value}`,
    });
  }

  clearTip(): void {
    this.tip.set(null);
  }

  private redraw(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const rows = this.displayRows();
    const m = this.metric();
    const drawn =
      this.variant === 'donut'
        ? drawAiDonutChart(canvas, rows, m)
        : drawAiBarChart(canvas, rows, m, this.variant === 'vertical' ? 'vertical' : 'horizontal');
    this.hits = drawn.hits;
    const palette = drawn.colors;
    this.legend.set(
      rows.map((row, i) => ({
        label: row.label,
        color: palette[i] || '#58a6ff',
        value: formatMetric(metricValue(row, m), m),
      }))
    );
  }
}
