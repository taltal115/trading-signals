import type { HourlyCandles } from './market-data.service';
import { fmtUiDecimal } from './positions-logic';

export interface HoldLineHit {
  cx: number;
  cy: number;
  index: number;
  timeSec: number;
  price: number;
}

export interface DrawHoldLineChartOpts {
  entryMs: number;
  exitMs: number;
  entryPrice: number;
  /** Exit price at the 3-trading-day mark; null if still in progress. */
  exitPrice: number | null;
  inProgress: boolean;
  /** Stop loss price level (optional). */
  stopPrice?: number | null;
  /** Take profit / target price level (optional). */
  targetPrice?: number | null;
}

/** Last bar at or before target time; falls back to 0. */
export function lastIndexAtOrBefore(timesSec: number[], targetMs: number): number {
  const target = targetMs / 1000;
  let best = -1;
  for (let i = 0; i < timesSec.length; i++) {
    if (timesSec[i] <= target) best = i;
    else break;
  }
  return best >= 0 ? best : 0;
}

function drawMarkerPoint(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  radius = 5
): void {
  ctx.beginPath();
  ctx.arc(x, y, radius + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/**
 * Line chart of hourly closes on a trading-bar X axis (equal index spacing).
 * Entry / exit markers sit on the bars nearest to signal 16:00 and +3 sessions 16:00.
 */
export function drawHoldLineChart(
  canvas: HTMLCanvasElement,
  candles: HourlyCandles,
  opts: DrawHoldLineChartOpts
): { hits: HoldLineHit[] } {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { hits: [] };

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const width = rect.width;
  const height = rect.height;

  const padding = { top: 28, right: 58, bottom: 36, left: 12 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const n = candles.t.length;
  if (n < 2) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(128,128,128,0.65)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Not enough hourly bars', width / 2, height / 2);
    return { hits: [] };
  }

  const entryIdx = lastIndexAtOrBefore(candles.t, opts.entryMs);
  const exitIdx = lastIndexAtOrBefore(candles.t, opts.exitMs);

  let minPrice = Math.min(...candles.c);
  let maxPrice = Math.max(...candles.c);
  if (opts.entryPrice > 0) {
    minPrice = Math.min(minPrice, opts.entryPrice);
    maxPrice = Math.max(maxPrice, opts.entryPrice);
  }
  if (opts.exitPrice != null && opts.exitPrice > 0) {
    minPrice = Math.min(minPrice, opts.exitPrice);
    maxPrice = Math.max(maxPrice, opts.exitPrice);
  }
  // Include stop and target in price range
  if (opts.stopPrice != null && opts.stopPrice > 0) {
    minPrice = Math.min(minPrice, opts.stopPrice);
    maxPrice = Math.max(maxPrice, opts.stopPrice);
  }
  if (opts.targetPrice != null && opts.targetPrice > 0) {
    minPrice = Math.min(minPrice, opts.targetPrice);
    maxPrice = Math.max(maxPrice, opts.targetPrice);
  }
  let priceRange = maxPrice - minPrice || 1;
  minPrice -= priceRange * 0.08;
  maxPrice += priceRange * 0.08;
  priceRange = maxPrice - minPrice;

  // Spread bars across width; in-progress keeps a slim gutter for planned-exit cue.
  const gutterSlots = opts.inProgress ? 0.35 : 0;
  const totalSlots = Math.max(n - 1, 1) + gutterSlots;
  const xAtIndex = (i: number) => padding.left + (i / totalSlots) * chartW;
  const yAtPrice = (p: number) => padding.top + chartH - ((p - minPrice) / priceRange) * chartH;

  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(128,128,128,0.2)';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const gy = padding.top + (chartH * g) / 4;
    ctx.beginPath();
    ctx.moveTo(padding.left, gy);
    ctx.lineTo(width - padding.right, gy);
    ctx.stroke();
  }

  const hits: HoldLineHit[] = [];
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(88, 166, 255, 0.95)';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const cx = xAtIndex(i);
    const cy = yAtPrice(candles.c[i]);
    if (i === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
    hits.push({
      cx,
      cy,
      index: i,
      timeSec: candles.t[i],
      price: candles.c[i],
    });
  }
  ctx.stroke();

  // Soft dots on each sample for hover affordance
  for (const h of hits) {
    ctx.beginPath();
    ctx.arc(h.cx, h.cy, 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(88, 166, 255, 0.55)';
    ctx.fill();
  }

  // Entry marker on signal-day close bar (not next open)
  if (opts.entryPrice > 0) {
    const ex = xAtIndex(entryIdx);
    const ey = yAtPrice(opts.entryPrice);
    ctx.strokeStyle = 'rgba(61, 214, 198, 0.4)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padding.left, ey);
    ctx.lineTo(width - padding.right, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    drawMarkerPoint(ctx, ex, ey, 'rgba(61, 214, 198, 1)');
    ctx.fillStyle = 'rgba(61, 214, 198, 0.95)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(
      'Entry $' + fmtUiDecimal(opts.entryPrice),
      Math.min(ex + 8, width - padding.right - 88),
      Math.max(padding.top + 12, ey - 8)
    );
  }

  // Stop loss level (red dashed line)
  if (opts.stopPrice != null && opts.stopPrice > 0) {
    const sy = yAtPrice(opts.stopPrice);
    ctx.strokeStyle = 'rgba(248, 81, 73, 0.6)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padding.left, sy);
    ctx.lineTo(width - padding.right, sy);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Check if stop was hit (any low <= stop)
    let stopHit = false;
    let stopHitIdx = -1;
    for (let i = 0; i < candles.l.length; i++) {
      if (candles.l[i] <= opts.stopPrice) {
        stopHit = true;
        stopHitIdx = i;
        break;
      }
    }
    
    if (stopHit && stopHitIdx >= 0) {
      const hx = xAtIndex(stopHitIdx);
      drawMarkerPoint(ctx, hx, sy, 'rgba(248, 81, 73, 1)', 4);
    }
    
    ctx.fillStyle = 'rgba(248, 81, 73, 0.95)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(
      'Stop $' + fmtUiDecimal(opts.stopPrice) + (stopHit ? ' ⚠️ HIT' : ''),
      width - padding.right - 4,
      Math.max(padding.top + 24, Math.min(sy - 4, height - padding.bottom - 12))
    );
  }

  // Take profit / target level (green dashed line)
  if (opts.targetPrice != null && opts.targetPrice > 0) {
    const ty = yAtPrice(opts.targetPrice);
    ctx.strokeStyle = 'rgba(63, 185, 80, 0.6)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padding.left, ty);
    ctx.lineTo(width - padding.right, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Check if target was hit (any high >= target)
    let targetHit = false;
    let targetHitIdx = -1;
    for (let i = 0; i < candles.h.length; i++) {
      if (candles.h[i] >= opts.targetPrice) {
        targetHit = true;
        targetHitIdx = i;
        break;
      }
    }
    
    if (targetHit && targetHitIdx >= 0) {
      const hx = xAtIndex(targetHitIdx);
      drawMarkerPoint(ctx, hx, ty, 'rgba(63, 185, 80, 1)', 4);
    }
    
    ctx.fillStyle = 'rgba(63, 185, 80, 0.95)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(
      'Target $' + fmtUiDecimal(opts.targetPrice) + (targetHit ? ' ✓ HIT' : ''),
      width - padding.right - 4,
      Math.min(ty + 14, height - padding.bottom - 4)
    );
  }

  // Exit at +3 trading days (exitIdx), not the last chart sample unless they coincide
  {
    if (opts.inProgress) {
      const xx = xAtIndex(n - 1 + gutterSlots * 0.85);
      ctx.strokeStyle = 'rgba(210, 153, 34, 0.55)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(xx, padding.top);
      ctx.lineTo(xx, padding.top + chartH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(210, 153, 34, 0.95)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('Planned exit', Math.min(xx - 4, width - padding.right - 4), padding.top + 12);
      const nowX = xAtIndex(n - 1);
      const nowY = yAtPrice(candles.c[n - 1]);
      drawMarkerPoint(ctx, nowX, nowY, 'rgba(210, 153, 34, 1)');
      ctx.fillStyle = 'rgba(210, 153, 34, 0.95)';
      ctx.textAlign = 'left';
      ctx.fillText(
        'Now $' + fmtUiDecimal(candles.c[n - 1]),
        Math.min(nowX + 8, width - padding.right - 70),
        Math.min(padding.top + chartH - 4, nowY + 14)
      );
    } else {
      const exitPx =
        opts.exitPrice != null && opts.exitPrice > 0 ? opts.exitPrice : candles.c[exitIdx];
      const xx = xAtIndex(exitIdx);
      const ey = yAtPrice(exitPx);
      ctx.strokeStyle = 'rgba(210, 153, 34, 0.4)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(padding.left, ey);
      ctx.lineTo(width - padding.right, ey);
      ctx.stroke();
      ctx.setLineDash([]);
      drawMarkerPoint(ctx, xx, ey, 'rgba(210, 153, 34, 1)');
      ctx.fillStyle = 'rgba(210, 153, 34, 0.95)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(
        'Exit $' + fmtUiDecimal(exitPx),
        Math.max(xx - 8, padding.left + 70),
        Math.max(padding.top + 12, ey - 8)
      );
    }
  }

  if (opts.inProgress) {
    ctx.fillStyle = 'rgba(128,128,128,0.8)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('In progress — hourly closes, trading-time spacing', padding.left, height - 10);
  }

  ctx.fillStyle = 'rgba(128,128,128,0.85)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  for (let g = 0; g <= 4; g++) {
    const p = maxPrice - (priceRange * g) / 4;
    const gy = padding.top + (chartH * g) / 4;
    ctx.fillText('$' + fmtUiDecimal(p), width - padding.right + 4, gy + 3);
  }

  return { hits };
}
