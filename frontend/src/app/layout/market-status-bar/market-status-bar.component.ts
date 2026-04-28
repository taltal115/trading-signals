import {
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
  PLATFORM_ID,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CommonModule } from '@angular/common';
import { DateTime } from 'luxon';

import { computeNyseMarketClock, type NyseMarketClockState } from '../../core/nyse-market-clock';

const NY_ZONE = 'America/New_York';

@Component({
  selector: 'app-market-status-bar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './market-status-bar.component.html',
  styleUrl: './market-status-bar.component.css',
})
export class MarketStatusBarComponent implements OnInit, OnDestroy {
  private readonly platformId = inject(PLATFORM_ID);

  readonly state = signal<NyseMarketClockState>({
    isOpen: false,
    headline: 'NYSE',
    detail: '—',
  });

  private timer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.tick();
    if (!isPlatformBrowser(this.platformId)) return;
    this.timer = setInterval(() => this.tick(), 1000);
  }

  ngOnDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const now = DateTime.now().setZone(NY_ZONE);
    this.state.set(computeNyseMarketClock(now));
  }
}
