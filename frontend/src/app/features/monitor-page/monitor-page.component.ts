import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import {
  MonitorStoreService,
  type MonitorAiAdviceFilter,
  type MonitorCheckRow,
  type MonitorTagFilter,
} from '../../core/monitor-store.service';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';

const PAGE_SIZE_OPTIONS = [10, 20, 30, 40, 50] as const;

interface MonitorCachedPage {
  rows: MonitorCheckRow[];
  nextCursor: string | null;
}

@Component({
  selector: 'app-monitor-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './monitor-page.component.html',
  styleUrl: './monitor-page.component.css',
})
export class MonitorPageComponent implements OnDestroy {
  private readonly monitorStore = inject(MonitorStoreService);
  readonly authSvc = inject(AuthService);
  readonly env = environment;

  private fetchSub: Subscription | null = null;
  private readySub: Subscription | null = null;

  readonly loadError = toSignal(this.monitorStore.error$, { initialValue: null });
  readonly loading = toSignal(this.monitorStore.loading$, { initialValue: false });

  readonly tagFilter = signal<MonitorTagFilter>('all');
  readonly aiAdviceFilter = signal<MonitorAiAdviceFilter>('all');
  readonly pageSize = signal<number>(20);
  readonly pageSizeOptions = PAGE_SIZE_OPTIONS;

  private readonly pages = signal<MonitorCachedPage[]>([]);
  readonly pageIndex = signal(0);
  readonly loadingPage = signal(false);

  readonly rows = computed(() => this.pages()[this.pageIndex()]?.rows ?? []);
  readonly pageLabel = computed(() => this.pageIndex() + 1);
  readonly canPrevPage = computed(() => this.pageIndex() > 0);
  readonly canNextPage = computed(() => {
    const pages = this.pages();
    const i = this.pageIndex();
    if (!pages.length) return false;
    if (i + 1 < pages.length) return true;
    return !!pages[i]?.nextCursor;
  });
  readonly hasAnyRows = computed(() => this.pages().some((p) => p.rows.length > 0));

  constructor() {
    this.readySub = this.monitorStore.ready$.subscribe((ready) => {
      if (ready) {
        this.resetAndFetch();
      } else {
        this.pages.set([]);
        this.pageIndex.set(0);
      }
    });
  }

  ngOnDestroy(): void {
    this.fetchSub?.unsubscribe();
    this.readySub?.unsubscribe();
  }

  str(n: number): string {
    return String(n);
  }

  onTagFilterChange(raw: string): void {
    const v = String(raw || 'all').toUpperCase();
    const next: MonitorTagFilter =
      v === 'WAIT' || v === 'SELL' ? v : 'all';
    if (next === this.tagFilter()) return;
    this.tagFilter.set(next);
    this.resetAndFetch();
  }

  onAiAdviceFilterChange(raw: string): void {
    const v = String(raw || 'all').toLowerCase();
    const next: MonitorAiAdviceFilter =
      v === 'has' || v === 'none' ? v : 'all';
    if (next === this.aiAdviceFilter()) return;
    this.aiAdviceFilter.set(next);
    this.resetAndFetch();
  }

  onPageSizeChange(raw: string): void {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n === this.pageSize()) return;
    this.pageSize.set(n);
    this.resetAndFetch();
  }

  prevPage(): void {
    if (!this.canPrevPage()) return;
    this.pageIndex.update((i) => Math.max(0, i - 1));
  }

  nextPage(): void {
    if (!this.canNextPage() || this.loading() || this.loadingPage()) return;
    const pages = this.pages();
    const i = this.pageIndex();
    if (i + 1 < pages.length) {
      this.pageIndex.set(i + 1);
      return;
    }
    const cursor = pages[i]?.nextCursor;
    if (!cursor) return;
    this.fetchPage(cursor, true);
  }

  aiAdviceLabel(data: Record<string, unknown>): string {
    const advice = data['holding_advice'];
    if (!advice || typeof advice !== 'object') return '—';
    const a = String((advice as Record<string, unknown>)['advice'] || '')
      .trim()
      .toUpperCase();
    return a || '—';
  }

  aiHeadline(data: Record<string, unknown>): string {
    const advice = data['holding_advice'];
    if (!advice || typeof advice !== 'object') return '';
    return String((advice as Record<string, unknown>)['headline'] || '').trim();
  }

  truncate(s: string, max = 48): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
  }

  private resetAndFetch(): void {
    this.pages.set([]);
    this.pageIndex.set(0);
    this.fetchPage(undefined, false);
  }

  private fetchPage(cursor: string | undefined, append: boolean): void {
    this.fetchSub?.unsubscribe();
    this.loadingPage.set(true);
    this.fetchSub = this.monitorStore
      .fetchPage({
        limit: this.pageSize(),
        cursor,
        tag: this.tagFilter(),
        aiAdvice: this.aiAdviceFilter(),
      })
      .subscribe((res) => {
        this.loadingPage.set(false);
        const page: MonitorCachedPage = {
          rows: res.rows,
          nextCursor: res.nextCursor,
        };
        if (append) {
          this.pages.update((prev) => [...prev, page]);
          this.pageIndex.update((i) => i + 1);
        } else {
          this.pages.set([page]);
          this.pageIndex.set(0);
        }
      });
  }
}
