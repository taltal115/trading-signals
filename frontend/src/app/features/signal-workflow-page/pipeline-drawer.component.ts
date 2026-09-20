import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SignalHoldChartComponent } from '../signal-hold-chart/signal-hold-chart.component';
import type {
  PipelineCondition,
  PipelineHeader,
  PipelineNode,
} from '../../core/pipeline-lifecycle.types';

@Component({
  selector: 'app-pipeline-drawer',
  standalone: true,
  imports: [CommonModule, SignalHoldChartComponent],
  templateUrl: './pipeline-drawer.component.html',
  styleUrl: './pipeline-drawer.component.css',
})
export class PipelineDrawerComponent {
  @Input() node: PipelineNode | null = null;
  @Input() header: PipelineHeader | null = null;
  @Output() readonly dismiss = new EventEmitter<void>();

  showRaw = false;

  fmt(v: unknown): string {
    if (v == null || v === '') return '—';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') {
      return Number.isInteger(v) ? String(v) : v.toFixed(2);
    }
    return String(v);
  }

  trackCond(_i: number, c: PipelineCondition): string {
    return c.id;
  }

  showHoldChart(): boolean {
    if (!this.node || !this.header) return false;
    return (
      (this.node.id === 'outcome' || this.node.id === 'paper' || this.node.id === 'holding') &&
      !!this.header.asofDate &&
      !!this.header.ticker &&
      (this.header.close ?? 0) > 0
    );
  }

  detailEntries(): { key: string; value: string }[] {
    const d = this.node?.detail;
    if (!d) return [];
    const skip = new Set(['provider_status', 'holding_advice', 'recent_checks']);
    return Object.entries(d)
      .filter(([k]) => !skip.has(k))
      .map(([key, value]) => ({
        key,
        value:
          value != null && typeof value === 'object'
            ? JSON.stringify(value)
            : this.fmt(value),
      }));
  }

  rawJson(): string {
    try {
      return JSON.stringify(this.node?.raw ?? this.node?.detail ?? {}, null, 2);
    } catch {
      return '{}';
    }
  }
}
