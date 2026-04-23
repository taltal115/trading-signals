import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

/**
 * Dispatches GitHub Actions via Nest (`GITHUB_PERSONAL_TOKEN` server-side only).
 */
@Injectable({ providedIn: 'root' })
export class GithubWorkflowsService {
  private readonly http = inject(HttpClient);

  private url(path: string): string {
    const base = environment.apiBaseUrl.replace(/\/$/, '');
    return `${base}/api/github${path}`;
  }

  async triggerMonitorWorkflow(ticker: string): Promise<void> {
    await firstValueFrom(
      this.http.post<{ ok: boolean }>(this.url('/workflows/position-monitor'), {
        ticker: String(ticker || '').trim(),
      }),
    );
  }

  async triggerBotScanWorkflow(ticker: string): Promise<void> {
    await firstValueFrom(
      this.http.post<{ ok: boolean }>(this.url('/workflows/bot-scan'), {
        ticker: String(ticker || '').trim(),
      }),
    );
  }

  async triggerAiStockEvalWorkflow(ticker: string, signalDocId: string): Promise<void> {
    await firstValueFrom(
      this.http.post<{ ok: boolean }>(this.url('/workflows/ai-stock-eval'), {
        ticker: String(ticker || '').trim(),
        signal_doc_id: String(signalDocId || '').trim(),
      }),
    );
  }
}
