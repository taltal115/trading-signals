import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Subscription, switchMap, catchError, of, tap } from 'rxjs';
import { formatApiErr } from '../../core/api-errors';
import { fmtUiDecimal } from '../../core/positions-logic';
import { environment } from '../../../environments/environment';

/** Row in Firestore ``universe.symbol_details`` (Finnhub profile + strategy scores). */
export interface UniverseSymbolDetail {
  name?: string;
  confidence?: number;
  score?: number;
  sector?: string;
  country?: string;
  market_cap?: number;
}

function normalizeSymbolDetails(
  raw: Record<string, unknown> | undefined
): Record<string, UniverseSymbolDetail> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, UniverseSymbolDetail> = {};
  for (const [k, v] of Object.entries(raw)) {
    const sym = String(k).trim().toUpperCase();
    if (sym && v && typeof v === 'object' && !Array.isArray(v)) {
      out[sym] = v as UniverseSymbolDetail;
    }
  }
  return out;
}

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
      symbol_details?: Record<string, UniverseSymbolDetail>;
    }[]
  >([]);

  protected readonly fmtUiDecimal = fmtUiDecimal;

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
          symbol_details?: Record<string, UniverseSymbolDetail>;
        }[] = [];
        for (const d of r.docs ?? []) {
          const x = d.data;
          const syms = Array.isArray(x.symbols)
            ? x.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
            : [];
          list.push({
            id: d.id,
            asof_date: x.asof_date,
            ts_utc: x.ts_utc,
            source: x.source,
            symbols: syms,
            symbol_details: normalizeSymbolDetails(
              x.symbol_details as Record<string, unknown> | undefined
            ),
          });
        }
        this.docs.set(list);
      });
  }

  /** Finnhub ``market_cap`` is USD millions (same as signals live snapshot). */
  fmtMarketCapMillions(millions: number | null | undefined): string {
    if (millions == null || !Number.isFinite(Number(millions))) return '—';
    const m = Number(millions);
    if (Math.abs(m) >= 1000) {
      return fmtUiDecimal(m / 1000) + 'B USD';
    }
    return fmtUiDecimal(m) + 'M USD';
  }

  fmtUniverseScore(score: number | null | undefined): string {
    if (score == null || !Number.isFinite(Number(score))) return '—';
    const s = Number(score);
    if (s >= 0 && s <= 1.0 + 1e-9) {
      return fmtUiDecimal(s * 100) + '%';
    }
    return fmtUiDecimal(s);
  }

  fmtConfidence(c: number | null | undefined): string {
    if (c == null || !Number.isFinite(Number(c))) return '—';
    return String(Math.round(Number(c)));
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  toggleRow(id: string): void {
    this.expandedId.update((cur) => (cur === id ? null : id));
  }
}
