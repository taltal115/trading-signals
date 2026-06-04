import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { EventRecommendation, StockEventRow } from '../../core/events-api.service';
import { StockSnapshot } from '../../core/market-data.service';
import { fmtUiPercent } from '../../core/positions-logic';

/** Expandable business + event context panel for one events table row. */
@Component({
  selector: 'app-events-event-detail',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './events-event-detail.component.html',
  styleUrl: './events-event-detail.component.css',
})
export class EventsEventDetailComponent {
  @Input({ required: true }) row!: StockEventRow;
  @Input() recommendation: EventRecommendation | null = null;
  @Input() snapshotLoading = false;
  @Input() snapshotError: string | null = null;
  @Input() marketSnap: StockSnapshot | null = null;

  @Input() fmtUsd!: (x: unknown) => string;
  @Input() fmtPct!: (v: number | null | undefined) => string;
  @Input() fmtNum!: (v: number | null | undefined, digits?: number) => string;
  @Input() fmtLarge!: (n: number | null | undefined) => string;
  @Input() fmtMarketCapMillions!: (millions: number | null, currency: string | null) => string;
  @Input() fmtUnixQuoteUtc!: (sec: number | null) => string;
  @Input() formatUniverseScore!: (score: number) => string;
  @Input() formatEventScore!: (score: number | undefined) => string;

  protected readonly fmtUiPercent = fmtUiPercent;
}
