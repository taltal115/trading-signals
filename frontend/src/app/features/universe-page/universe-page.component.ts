import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Subscription, switchMap, catchError, of, tap } from 'rxjs';
import { formatApiErr } from '../../core/api-errors';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-universe-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './universe-page.component.html',
  styleUrl: './universe-page.component.css',
})
export class UniversePageComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private sub: Subscription | null = null;

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly docs = signal<
    {
      id: string;
      asof_date?: string;
      ts_utc?: string;
      source?: string;
      symbols: string[];
      symbol_details?: Record<string, { name?: string; sector?: string }>;
    }[]
  >([]);

  readonly expandedId = signal<string | null>(null);

  ngOnInit(): void {
    const base = environment.apiBaseUrl;
    this.sub = of(0)
      .pipe(
        switchMap(() =>
          this.http
            .get<{
              docs: {
                id: string;
                data: {
                  asof_date?: string;
                  ts_utc?: string;
                  source?: string;
                  symbols?: string[];
                  symbol_details?: Record<string, unknown>;
                };
              }[];
            }>(`${base}/api/universe`)
            .pipe(
              tap({ next: () => this.error.set(null) }),
              catchError((err) => {
                this.loading.set(false);
                this.error.set(formatApiErr(err));
                return of({ docs: [] });
              })
            )
        )
      )
      .subscribe((r) => {
        this.loading.set(false);
        const list: {
          id: string;
          asof_date?: string;
          ts_utc?: string;
          source?: string;
          symbols: string[];
          symbol_details?: Record<string, { name?: string; sector?: string }>;
        }[] = [];
        for (const d of r.docs ?? []) {
          const x = d.data;
          list.push({
            id: d.id,
            asof_date: x.asof_date,
            ts_utc: x.ts_utc,
            source: x.source,
            symbols: Array.isArray(x.symbols) ? x.symbols : [],
            symbol_details: x.symbol_details as
              | Record<string, { name?: string; sector?: string }>
              | undefined,
          });
        }
        this.docs.set(list);
      });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  toggleRow(id: string): void {
    this.expandedId.update((cur) => (cur === id ? null : id));
  }
}
