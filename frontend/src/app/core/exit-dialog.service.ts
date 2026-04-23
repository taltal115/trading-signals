import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface ExitDialogPayload {
  docId: string;
  ticker: string;
  entry: number;
  /** Shares for USD P&L; omitted or invalid uses implicit 1 (see `effectiveQuantity` in positions-logic). */
  quantity?: number | null;
}

@Injectable({ providedIn: 'root' })
export class ExitDialogService {
  readonly openRequest$ = new Subject<ExitDialogPayload>();
  /** Fires after a position exit (PATCH) succeeds and the exit dialog is closing. */
  readonly exitSaved$ = new Subject<void>();

  requestOpen(p: ExitDialogPayload): void {
    this.openRequest$.next(p);
  }
}
