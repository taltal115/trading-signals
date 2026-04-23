import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { formatApiErr } from './api-errors';
import { environment } from '../../environments/environment';

export interface OpenPositionFormValue {
  ticker: string;
  entry_price: number;
  quantity: number | null;
  stop_price: number | null;
  target_price: number | null;
  signal_doc_id: string | null;
  signal_confidence: number | null;
  hold_days_from_signal: number | null;
  signal_close_price: number | null;
  bought_at: string | null;
  notes: string | null;
  sector: string | null;
  industry: string | null;
  estimated_hold_days: number | null;
}

@Injectable({ providedIn: 'root' })
export class OpenPositionService {
  private readonly http = inject(HttpClient);

  async save(v: OpenPositionFormValue): Promise<void> {
    const base = environment.apiBaseUrl;
    try {
      await firstValueFrom(this.http.post(`${base}/api/positions`, v));
    } catch (err) {
      throw new Error(formatApiErr(err));
    }
  }
}
