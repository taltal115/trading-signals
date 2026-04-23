import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface ExitDialogPayload {
  docId: string;
  ticker: string;
  entry: number;
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
