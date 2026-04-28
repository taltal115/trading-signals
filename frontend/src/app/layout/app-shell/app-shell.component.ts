import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription, firstValueFrom, distinctUntilChanged } from 'rxjs';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { PositionsStoreService } from '../../core/positions-store.service';
import { MonitorStoreService } from '../../core/monitor-store.service';
import { FormsModule } from '@angular/forms';
import { formatApiErr } from '../../core/api-errors';
import { environment } from '../../../environments/environment';
import { ExitDialogService, type ExitDialogPayload } from '../../core/exit-dialog.service';
import { SignalsNewBadgeService } from '../../core/signals-new-badge.service';
import {
  effectiveQuantity,
  fmtSignedUsd,
  fmtUiDecimal,
  quantityWasInferred,
  type PositionData,
} from '../../core/positions-logic';
import { MarketStatusBarComponent } from '../market-status-bar/market-status-bar.component';

const SIDEBAR_COLLAPSED_KEY = 'signals-sidebar-collapsed';

@Component({
  selector: 'app-app-shell',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    FormsModule,
    MarketStatusBarComponent,
  ],
  templateUrl: './app-shell.component.html',
  styleUrl: './app-shell.component.css',
})
export class AppShellComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  readonly authSvc = inject(AuthService);
  private readonly positionsStore = inject(PositionsStoreService);
  private readonly monitorStore = inject(MonitorStoreService);
  private readonly exitDialogSvc = inject(ExitDialogService);
  readonly signalsNewBadge = inject(SignalsNewBadgeService);
  private exitSub?: Subscription;
  private authStoreSub?: Subscription;
  /** Avoid repeated `start()` (and duplicate `/api/positions` fetches) if `allowedUser$` re-emits the same uid. */
  private lastStoreUid: string | null = null;

  readonly mobileOpen = signal(false);
  readonly sidebarCollapsed = signal(false);

  private readonly mq = typeof matchMedia !== 'undefined' ? matchMedia('(max-width: 900px)') : null;

  exitDocId: string | null = null;
  exitTicker = '';
  exitEntry = 0;
  exitQuantity: number | null = null;
  exitPrice = '';
  exitNotes = '';
  readonly exitSaving = signal(false);
  readonly exitResultSummary = signal<{
    ticker: string;
    pnlUsd: number;
    pnlPct: number | null;
    quantityInferred: boolean;
  } | null>(null);

  ngOnInit(): void {
    if (typeof localStorage !== 'undefined') {
      try {
        this.sidebarCollapsed.set(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
      } catch {
        /* ignore */
      }
    }

    if (environment.devAuthBypass) {
      /** Local dev: `/api/positions` uses Nest session bypass even when `/api/auth/me` is still null. */
      this.authStoreSub = this.authSvc.user$
        .pipe(distinctUntilChanged((a, b) => a?.uid === b?.uid))
        .subscribe((u) => {
          this.positionsStore.start(u?.uid ?? 'dev');
          if (u) {
            this.monitorStore.start(u.uid);
          } else {
            this.monitorStore.stop();
          }
        });
    } else {
      this.authStoreSub = this.authSvc.allowedUser$.subscribe((u) => {
        if (u) {
          if (this.lastStoreUid !== u.uid) {
            this.lastStoreUid = u.uid;
            this.positionsStore.start(u.uid);
            this.monitorStore.start(u.uid);
          }
        } else {
          this.lastStoreUid = null;
          this.positionsStore.stop();
          this.monitorStore.stop();
        }
      });
    }

    this.exitSub = this.exitDialogSvc.openRequest$.subscribe((p) => this.openExitDialog(p));

    this.mq?.addEventListener('change', () => {
      if (!this.isMobile()) this.mobileOpen.set(false);
    });
  }

  ngOnDestroy(): void {
    this.exitSub?.unsubscribe();
    this.authStoreSub?.unsubscribe();
    this.positionsStore.stop();
    this.monitorStore.stop();
  }

  isMobile(): boolean {
    return this.mq?.matches ?? false;
  }

  toggleMobileNav(): void {
    this.mobileOpen.update((v) => !v);
  }

  closeMobileNav(): void {
    this.mobileOpen.set(false);
  }

  toggleSidebarCollapse(): void {
    this.sidebarCollapsed.update((c) => !c);
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, this.sidebarCollapsed() ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  async signOutClick(): Promise<void> {
    await this.authSvc.signOutApp();
  }

  private openExitDialog(p: ExitDialogPayload): void {
    this.exitSaving.set(false);
    this.exitDocId = p.docId;
    this.exitTicker = p.ticker;
    this.exitEntry = p.entry;
    this.exitQuantity = p.quantity ?? null;
    this.exitPrice = '';
    this.exitNotes = '';
    queueMicrotask(() =>
      (document.getElementById('exit-dialog') as HTMLDialogElement | null)?.showModal()
    );
  }

  closeExitDialog(): void {
    (document.getElementById('exit-dialog') as HTMLDialogElement | null)?.close();
  }

  onExitDialogCancel(ev: Event): void {
    if (this.exitSaving()) {
      ev.preventDefault();
    }
  }

  closeExitResultDialog(): void {
    (document.getElementById('exit-result-dialog') as HTMLDialogElement | null)?.close();
  }

  onExitResultDialogClosed(): void {
    this.exitResultSummary.set(null);
  }

  protected exitResultPnlClass(pnlPct: number | null): string {
    if (pnlPct == null || !Number.isFinite(pnlPct)) return 'pnl-flat';
    if (pnlPct > 0.0001) return 'pnl-profit';
    if (pnlPct < -0.0001) return 'pnl-loss';
    return 'pnl-flat';
  }

  protected fmtExitSignedUsd(n: number): string {
    return fmtSignedUsd(n);
  }

  protected fmtExitPct(pnlPct: number | null): string {
    if (pnlPct == null || !Number.isFinite(pnlPct)) return '—';
    const sign = pnlPct > 0 ? '+' : '';
    return sign + fmtUiDecimal(pnlPct) + '%';
  }

  async submitExit(): Promise<void> {
    if (!this.exitDocId) {
      this.closeExitDialog();
      return;
    }
    const price = parseFloat(this.exitPrice);
    if (!Number.isFinite(price) || price <= 0) {
      alert('Enter a valid sell price.');
      return;
    }
    const entry = this.exitEntry;
    const pnl_pct = entry > 0 ? ((price - entry) / entry) * 100 : null;
    const qtyData = { quantity: this.exitQuantity } as PositionData;
    const qty = effectiveQuantity(qtyData);
    const pnlUsd = (price - entry) * qty;
    const summaryTicker = this.exitTicker;
    const quantityInferred = quantityWasInferred(qtyData);
    const ts = new Date().toISOString();
    const base = environment.apiBaseUrl;
    this.exitSaving.set(true);
    try {
      await firstValueFrom(
        this.http.patch<{ ok: boolean }>(`${base}/api/positions/${this.exitDocId}`, {
          status: 'closed',
          exit_price: price,
          exit_at_utc: ts,
          exit_notes: this.exitNotes.trim() || null,
          pnl_pct,
          closed_at_utc: ts,
          exit_origin: 'user',
          monitor_close_kind: null,
        })
      );
      this.closeExitDialog();
      this.exitDocId = null;
      this.exitResultSummary.set({
        ticker: summaryTicker,
        pnlUsd,
        pnlPct: pnl_pct,
        quantityInferred,
      });
      this.positionsStore.refetch();
      this.exitDialogSvc.exitSaved$.next();
      setTimeout(() => {
        (document.getElementById('exit-result-dialog') as HTMLDialogElement | null)?.showModal();
      }, 0);
    } catch (err) {
      alert('Could not save exit: ' + formatApiErr(err));
    } finally {
      this.exitSaving.set(false);
    }
  }

  protected readonly env = environment;
}
