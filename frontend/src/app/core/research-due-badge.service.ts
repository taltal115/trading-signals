import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';

/**
 * In-app badge when profit-hold next_research.due_date is today or overdue.
 * Ack clears until a newer due_date appears.
 */
@Injectable({ providedIn: 'root' })
export class ResearchDueBadgeService {
  private readonly auth = inject(AuthService);
  readonly overdue = signal(false);
  readonly dueDate = signal<string | null>(null);
  private currentUid: string | null = null;
  private lastDue: string | null = null;

  constructor() {
    this.auth.allowedUser$.subscribe((u) => {
      this.currentUid = u?.uid ?? null;
      this.refreshFromDue(this.lastDue);
    });
  }

  private storageKey(): string {
    return this.currentUid
      ? `research-due-ack-v1-${this.currentUid}`
      : `research-due-ack-v1-anon`;
  }

  /** Call when research runs list/detail updates. */
  refreshFromDue(dueDate: string | null | undefined): void {
    const due = String(dueDate || '').trim() || null;
    this.lastDue = due;
    this.dueDate.set(due);
    if (!due) {
      this.overdue.set(false);
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const isDue = due <= today;
    if (!isDue) {
      this.overdue.set(false);
      return;
    }
    try {
      const ack = localStorage.getItem(this.storageKey());
      this.overdue.set(ack !== due);
    } catch {
      this.overdue.set(true);
    }
  }

  acknowledge(): void {
    const due = this.dueDate();
    if (!due) return;
    try {
      localStorage.setItem(this.storageKey(), due);
    } catch {
      /* ignore */
    }
    this.overdue.set(false);
  }
}
