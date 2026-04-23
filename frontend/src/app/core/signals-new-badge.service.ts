import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import type { SignalDoc } from './signal-docs-normalize';

type SignalDocRow = { id: string; data: SignalDoc };

function maxAsofFromDocs(docs: SignalDocRow[]): string | null {
  let max = '';
  for (const d of docs) {
    const a = String(d.data.asof_date || '').trim();
    if (a > max) max = a;
  }
  return max || null;
}

/**
 * Tracks which signal table rows the user has opened via "Log Buy" (per uid, persisted).
 * "New" = BUY rows on the latest `asof_date` run that are not yet acknowledged.
 */
@Injectable({ providedIn: 'root' })
export class SignalsNewBadgeService {
  private readonly auth = inject(AuthService);

  /** Count of latest-run rows not yet acknowledged with Log Buy. */
  readonly count = signal(0);

  private seen = new Set<string>();
  private currentUid: string | null = null;
  private lastDocs: SignalDocRow[] = [];

  constructor() {
    this.auth.allowedUser$.subscribe((u) => {
      this.currentUid = u?.uid ?? null;
      this.loadSeen();
      this.recompute(this.lastDocs);
    });
  }

  private storageKey(): string {
    return this.currentUid
      ? `signals-log-buy-ack-v1-${this.currentUid}`
      : `signals-log-buy-ack-v1-anon`;
  }

  private loadSeen(): void {
    this.seen = new Set();
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (!raw) return;
      const arr = JSON.parse(raw) as string[];
      if (Array.isArray(arr)) for (const k of arr) this.seen.add(String(k));
    } catch {
      /* ignore */
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify([...this.seen]));
    } catch {
      /* ignore */
    }
  }

  /** Call after `/api/signals` returns (normalized docs). */
  recompute(docs: SignalDocRow[]): void {
    this.lastDocs = docs;
    const max = maxAsofFromDocs(docs);
    if (!max) {
      this.count.set(0);
      return;
    }
    let n = 0;
    for (const doc of docs) {
      const asof = String(doc.data.asof_date || '').trim();
      if (asof !== max) continue;
      const arr = Array.isArray(doc.data.signals) ? doc.data.signals : [];
      for (const s of arr) {
        const t = String(s['ticker'] || '')
          .trim()
          .toUpperCase();
        if (!t) continue;
        const rowKey = doc.id + '\t' + t;
        if (!this.seen.has(rowKey)) n++;
      }
    }
    this.count.set(n);
  }

  /** True when this row is on the latest run and Log Buy was never clicked for it. */
  isRowNew(rowKey: string, asofDate: string, docs: SignalDocRow[]): boolean {
    const max = maxAsofFromDocs(docs);
    if (!max || String(asofDate).trim() !== max) return false;
    return !this.seen.has(rowKey);
  }

  /** User clicked "Log Buy" — clear highlight and decrement badge. */
  acknowledgeLogBuy(rowKey: string): void {
    if (this.seen.has(rowKey)) return;
    this.seen.add(rowKey);
    this.persist();
    this.recompute(this.lastDocs);
  }
}
