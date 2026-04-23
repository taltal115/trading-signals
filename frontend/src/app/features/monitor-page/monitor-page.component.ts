import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { MonitorStoreService } from '../../core/monitor-store.service';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-monitor-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './monitor-page.component.html',
  styleUrl: './monitor-page.component.css',
})
export class MonitorPageComponent {
  private readonly monitorStore = inject(MonitorStoreService);
  readonly authSvc = inject(AuthService);
  readonly env = environment;

  readonly rows = toSignal(this.monitorStore.rows$, { initialValue: [] });
  readonly loadError = toSignal(this.monitorStore.error$, { initialValue: null });
  readonly loading = toSignal(this.monitorStore.loading$, { initialValue: false });
}
