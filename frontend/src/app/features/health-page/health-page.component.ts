import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { HealthService } from '../../core/health.service';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-health-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './health-page.component.html',
  styleUrl: './health-page.component.css',
})
export class HealthPageComponent implements OnInit, OnDestroy {
  readonly healthService = inject(HealthService);
  readonly authSvc = inject(AuthService);

  readonly status = toSignal(this.healthService.status$, { initialValue: null });
  readonly loading = toSignal(this.healthService.loading$, { initialValue: false });
  readonly error = toSignal(this.healthService.error$, { initialValue: null });

  private refreshInterval: any;

  ngOnInit() {
    this.refresh();
  }

  ngOnDestroy() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  refresh() {
    this.healthService.fetchStatus();
  }

  formatResponseTime(ms: number | undefined): string {
    if (ms === undefined) return '-';
    return `${Math.round(ms)}ms`;
  }

  formatLastChecked(timestamp: string): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }
}
