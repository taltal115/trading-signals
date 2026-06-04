import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { formatApiErr } from './api-errors';

export interface EventSetup {
  ret_5d_pct?: number;
  ret_10d_pct?: number;
  rel_vol?: number;
  rsi14?: number;
  is_breakout?: boolean;
  price_vs_sma20_pct?: number;
  spy_rel_20d_pct?: number | null;
  pre_event_extended?: boolean;
}

export interface EventHistory {
  samples?: number;
  median_post_5d_pct?: number | null;
  pct_positive_post_5d?: number | null;
  median_gap_day_pct?: number | null;
}

export interface StockEventRow {
  symbol: string;
  event_type: string;
  event_date: string;
  event_time: string | null;
  title: string;
  eps_estimate: number | null;
  revenue_estimate: number | null;
  last_score: number;
  last_confidence: number | null;
  data_source: string;
  setup?: EventSetup | null;
  history?: EventHistory | null;
  event_score?: number;
  bias?: string;
  action?: string;
  reasons?: string[];
}

export interface EventRecommendation {
  rank: number;
  symbol: string;
  event_type: string;
  event_date: string;
  action: string;
  bias: string;
  event_score: number;
  summary: string;
  reasons: string[];
}

export interface StockEventsLatestResponse {
  docId: string;
  asof_date: string;
  ts_utc: string;
  universe_doc_id: string;
  top_symbols_n: number;
  rank_by: string;
  horizon_days: number;
  source?: string;
  events: StockEventRow[];
  recommendations: EventRecommendation[];
}

@Injectable({ providedIn: 'root' })
export class EventsApiService {
  private readonly http = inject(HttpClient);

  async getLatest(): Promise<StockEventsLatestResponse> {
    const base = environment.apiBaseUrl;
    try {
      const raw = await firstValueFrom(
        this.http.get<StockEventsLatestResponse>(`${base}/api/events/latest`)
      );
      return {
        ...raw,
        recommendations: raw.recommendations ?? [],
      };
    } catch (err) {
      throw new Error(formatApiErr(err));
    }
  }
}
