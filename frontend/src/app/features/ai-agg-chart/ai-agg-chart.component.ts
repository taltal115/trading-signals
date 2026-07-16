import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  AiChartMetric,
  AiChartRow,
  drawAiBarChart,
  drawAiDonutChart,
} from '../../core/ai-analytics-chart.util';

export type AiChartVariant = 'donut' | 'vertical' | 'horizontal';

@Component({
  selector: 'app-ai-agg-chart',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ai-agg-chart.component.html',
  styleUrl: './ai-agg-chart.component.css',
})
export class AiAggChartComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) title = '';
  @Input({ required: true }) rows: AiChartRow[] = [];
  @Input() variant: AiChartVariant = 'horizontal';

  @ViewChild('canvasEl', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly metrics: AiChartMetric[] = ['requests', 'tokens', 'cost'];
  readonly metric = signal<AiChartMetric>('cost');

  private ro: ResizeObserver | null = null;

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    this.ro = new ResizeObserver(() => this.redraw());
    this.ro.observe(canvas.parentElement || canvas);
    this.redraw();
  }

  ngOnChanges(_changes: SimpleChanges): void {
    queueMicrotask(() => this.redraw());
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
  }

  setMetric(m: AiChartMetric): void {
    this.metric.set(m);
    this.redraw();
  }

  private redraw(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const rows = this.rows || [];
    const m = this.metric();
    if (this.variant === 'donut') {
      drawAiDonutChart(canvas, rows, m);
    } else {
      drawAiBarChart(canvas, rows, m, this.variant === 'vertical' ? 'vertical' : 'horizontal');
    }
  }
}
