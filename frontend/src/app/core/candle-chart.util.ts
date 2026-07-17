import type { HourlyCandles } from './market-data.service';
import { fmtUiDecimal } from './positions-logic';

export interface CandleHit {
  x: number;
  /** Candle center x for hit-testing. */
  cx: number;
  index: number;
  timeSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DrawCandleChartOpts {
  entryMs: number;
  exitMs: number;
  entryPrice: number;
  /** Exit price when window complete and bars exist; null = planned exit only. */
  exitPrice: number | null;
  inProgress: boolean;
}

export function drawCandleChart(
  canvas: HTMLCanvasElement,
  candles: HourlyCandles,
  opts: DrawCandleChartOpts
): { hits: CandleHit[] } {
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

  let minPrice = Math.min(...candles.l);
  let maxPrice = Math.max(...candles.h);
  if (opts.entryPrice > 0) {
    minPrice = Math.min(minPrice, opts.entryPrice);
    maxPrice = Math.max(maxPrice, opts.entryPrice);
  }
  if (opts.exitPrice != null && opts.exitPrice > 0) {
    minPrice = Math.min(minPrice, opts.exitPrice);
    maxPrice = Math.max(maxPrice, opts.exitPrice);
  }
  let priceRange = maxPrice - minPrice || 1;
  minPrice -= priceRange * 0.08;
  maxPrice += priceRange * 0.08;
  priceRange = maxPrice - minPrice;

  const t0 = Math.min(candles.t[0] * 1000, opts.entryMs);
  const t1 = Math.max(candles.t[n - 1] * 1000, opts.exitMs);
  const timeSpan = Math.max(1, t1 - t0);

  const xAtMs = (ms: number) => padding.left + ((ms - t0) / timeSpan) * chartW;
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

  const slot = chartW / Math.max(n, 1);
  const bodyW = Math.max(2, Math.min(10, slot * 0.55));
  const hits: CandleHit[] = [];

  for (let i = 0; i < n; i++) {
    const ts = candles.t[i];
    const o = candles.o[i];
    const h = candles.h[i];
    const l = candles.l[i];
    const c = candles.c[i];
    const cx = xAtMs(ts * 1000);
    const yO = yAtPrice(o);
    const yC = yAtPrice(c);
    const yH = yAtPrice(h);
    const yL = yAtPrice(l);
    const up = c >= o;
    const color = up ? 'rgba(46, 160, 67, 0.95)' : 'rgba(248, 81, 73, 0.95)';

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, yH);
    ctx.lineTo(cx, yL);
    ctx.stroke();

    const top = Math.min(yO, yC);
    const bot = Math.max(yO, yC);
    const bh = Math.max(1, bot - top);
    ctx.fillStyle = color;
    ctx.fillRect(cx - bodyW / 2, top, bodyW, bh);

    hits.push({
      x: cx - bodyW / 2,
      cx,
      index: i,
      timeSec: ts,
      open: o,
      high: h,
      low: l,
      close: c,
    });
  }

  // Entry marker (static)
  if (opts.entryPrice > 0) {
    const ex = xAtMs(opts.entryMs);
    const ey = yAtPrice(opts.entryPrice);
    ctx.strokeStyle = 'rgba(61, 214, 198, 0.85)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(ex, padding.top);
    ctx.lineTo(ex, padding.top + chartH);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(padding.left, ey);
    ctx.lineTo(width - padding.right, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(61, 214, 198, 0.95)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Entry $' + fmtUiDecimal(opts.entryPrice), Math.min(ex + 4, width - padding.right - 90), padding.top + 12);
  }

  // Exit marker (static time; price when known)
  {
    const xx = xAtMs(opts.exitMs);
    ctx.strokeStyle = 'rgba(210, 153, 34, 0.9)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(xx, padding.top);
    ctx.lineTo(xx, padding.top + chartH);
    ctx.stroke();
    ctx.setLineDash([]);
    if (opts.exitPrice != null && opts.exitPrice > 0) {
      const ey = yAtPrice(opts.exitPrice);
      ctx.beginPath();
      ctx.setLineDash([2, 3]);
      ctx.moveTo(padding.left, ey);
      ctx.lineTo(width - padding.right, ey);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(210, 153, 34, 0.95)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(
        'Exit $' + fmtUiDecimal(opts.exitPrice),
        Math.max(xx - 4, padding.left + 70),
        padding.top + 12
      );
    } else {
      ctx.fillStyle = 'rgba(210, 153, 34, 0.95)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(
        opts.inProgress ? 'Planned exit' : 'Exit',
        Math.max(xx - 4, padding.left + 70),
        padding.top + 12
      );
    }
  }

  if (opts.inProgress) {
    ctx.fillStyle = 'rgba(128,128,128,0.8)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('In progress — showing bars through now', padding.left, height - 10);
  }

  // Y-axis labels
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
