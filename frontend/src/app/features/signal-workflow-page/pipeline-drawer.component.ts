import { Component, EventEmitter, Input, Output, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SignalHoldChartComponent } from '../signal-hold-chart/signal-hold-chart.component';
import {
  SignalLifecycleService,
  type NewsArticleItem,
} from '../../core/signal-lifecycle.service';
import { formatApiErr } from '../../core/api-errors';
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
  private readonly lifecycle = inject(SignalLifecycleService);

  @Input() node: PipelineNode | null = null;
  @Input() header: PipelineHeader | null = null;
  @Output() readonly dismiss = new EventEmitter<void>();

  showRaw = false;

  readonly articlesOpenFor = signal<string | null>(null);
  readonly articlesLoading = signal(false);
  readonly articlesError = signal<string | null>(null);
  readonly articles = signal<NewsArticleItem[]>([]);
  readonly articlesBrowseUrl = signal<string | null>(null);
  readonly articlesMessage = signal<string | null>(null);

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

  hasArticlesLink(c: PipelineCondition): boolean {
    return !!(c.articlesProvider || c.href);
  }

  toggleArticles(c: PipelineCondition): void {
    if (!c.articlesProvider || !this.header?.ticker) {
      return;
    }
    const key = c.id;
    if (this.articlesOpenFor() === key) {
      this.articlesOpenFor.set(null);
      return;
    }
    this.articlesOpenFor.set(key);
    this.articlesLoading.set(true);
    this.articlesError.set(null);
    this.articles.set([]);
    this.articlesBrowseUrl.set(c.href || null);
    this.articlesMessage.set(null);

    this.lifecycle
      .fetchNewsArticles({
        ticker: this.header.ticker,
        provider: c.articlesProvider,
      })
      .subscribe({
        next: (res) => {
          this.articles.set(res.articles || []);
          this.articlesBrowseUrl.set(res.browseUrl || c.href || null);
          this.articlesMessage.set(res.message || null);
          this.articlesLoading.set(false);
        },
        error: (err) => {
          this.articlesError.set(formatApiErr(err));
          this.articlesLoading.set(false);
        },
      });
  }
}
