import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { map } from 'rxjs';
import { PositionsStoreService } from '../../core/positions-store.service';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';
import type { PositionRow } from '../../core/positions-logic';
@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.css',
})
export class DashboardComponent {
  private readonly positionsStore = inject(PositionsStoreService);
  readonly authSvc = inject(AuthService);

  readonly openPositions$ = this.positionsStore.rows$.pipe(
    map((rows) => rows.filter((r) => r.data.status === 'open'))
  );

  readonly env = environment;

  spotClass(p: PositionRow, spot: number | null | undefined): string {
    const entry = p.data.entry_price != null ? Number(p.data.entry_price) : null;
    if (spot == null || !Number.isFinite(spot)) return 'pos-card-spot';
    if (entry != null && entry > 0) {
      if (spot > entry) return 'pos-card-spot spot-up';
      if (spot < entry) return 'pos-card-spot spot-down';
    }
    return 'pos-card-spot';
  }

  actionTag(kind: string | null | undefined): { text: string; cls: string } {
    const isSell = kind && ['STOP_HIT', 'TARGET_HIT', 'DURATION_DUE'].includes(kind);
    return isSell ? { text: 'SELL', cls: 'tag-sell' } : { text: 'WAIT', cls: 'tag-wait' };
  }
}
