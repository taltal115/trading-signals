import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';

type AggRow = { key: string; requests: number; tokens: number; cost: number };

@Component({
  selector: 'app-ai-analytics-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ai-analytics-page.component.html',
  styleUrl: './ai-analytics-page.component.css',
})
export class AiAnalyticsPageComponent implements OnInit {
  private readonly http = inject(HttpClient);

  readonly loading = signal(true);
  readonly error = signal('');
  readonly rows = signal<Record<string, unknown>[]>([]);

  readonly totals = computed(() => {
    let requests = 0;
    let tokens = 0;
    let cost = 0;
    for (const r of this.rows()) {
      requests += 1;
      tokens += Number(r['total_tokens'] || 0) || 0;
      cost += Number(r['estimated_cost_usd'] || 0) || 0;
    }
    return { requests, tokens, cost };
  });

  readonly byStage = computed(() => this.aggregate('stage'));
  readonly byTicker = computed(() => this.aggregate('ticker'));
  readonly byDay = computed(() => {
    const map = new Map<string, AggRow>();
    for (const r of this.rows()) {
      const ts = String(r['ts_utc'] || '');
      const day = ts.slice(0, 10) || 'unknown';
      const cur = map.get(day) || { key: day, requests: 0, tokens: 0, cost: 0 };
      cur.requests += 1;
      cur.tokens += Number(r['total_tokens'] || 0) || 0;
      cur.cost += Number(r['estimated_cost_usd'] || 0) || 0;
      map.set(day, cur);
    }
    return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
  });

  private aggregate(field: string): AggRow[] {
    const map = new Map<string, AggRow>();
    for (const r of this.rows()) {
      const key = String(r[field] || 'unknown');
      const cur = map.get(key) || { key, requests: 0, tokens: 0, cost: 0 };
      cur.requests += 1;
      cur.tokens += Number(r['total_tokens'] || 0) || 0;
      cur.cost += Number(r['estimated_cost_usd'] || 0) || 0;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.requests - a.requests);
  }

  asNum(v: unknown): number | null {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const base = environment.apiBaseUrl || '';
      const res = await firstValueFrom(
        this.http.get<{ rows: { id: string; data: Record<string, unknown> }[] }>(
          `${base}/api/signals/ai-evals/recent?limit=300`,
          { withCredentials: true }
        )
      );
      this.rows.set((res.rows || []).map((r) => ({ id: r.id, ...r.data })));
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }
}
