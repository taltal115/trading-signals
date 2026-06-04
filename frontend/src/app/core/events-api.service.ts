import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { formatApiErr } from './api-errors';

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
}

export interface StockEventsLatestResponse {
  docId: string;
  asof_date: string;
  ts_utc: string;
  universe_doc_id: string;
  top_symbols_n: number;
  rank_by: string;
  horizon_days: number;
  events: StockEventRow[];
}

@Injectable({ providedIn: 'root' })
export class EventsApiService {
  private readonly http = inject(HttpClient);

  async getLatest(): Promise<StockEventsLatestResponse> {
    const base = environment.apiBaseUrl;
    try {
      return await firstValueFrom(
        this.http.get<StockEventsLatestResponse>(`${base}/api/events/latest`)
      );
    } catch (err) {
      throw new Error(formatApiErr(err));
    }
  }
}
