import { Component, inject, OnInit, signal } from '@angular/core';
import {
  Router,
  RouterOutlet,
  NavigationStart,
  NavigationEnd,
  NavigationCancel,
  NavigationError,
} from '@angular/router';
import { AuthService } from './core/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit {
  title = 'signals dashboard';
  private readonly authSvc = inject(AuthService);
  private readonly router = inject(Router);

  bootHidden = false;
  readonly navLoading = signal(false);
  private navSeq = 0;
  private navHideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationStart) {
        if (this.navHideTimer) {
          clearTimeout(this.navHideTimer);
          this.navHideTimer = null;
        }
        this.navSeq += 1;
        this.navLoading.set(true);
      }
      if (
        e instanceof NavigationEnd ||
        e instanceof NavigationCancel ||
        e instanceof NavigationError
      ) {
        const seq = this.navSeq;
        const minMs = 280;
        this.navHideTimer = setTimeout(() => {
          this.navHideTimer = null;
          if (seq === this.navSeq) this.navLoading.set(false);
        }, minMs);
      }
    });
  }

  async ngOnInit(): Promise<void> {
    await this.authSvc.refreshMe();
    this.bootHidden = true;
  }
}
