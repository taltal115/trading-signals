import type { DailyCandles } from './market-data.service';
import { fmtUiDecimal, fmtUiPercent } from './positions-logic';

export interface ChartPoint {
  x: number;
  y: number;
  price: number;
  date: Date;
}

export function drawPriceChart(
  canvas: HTMLCanvasElement,
  candles: DailyCandles,
  entryPrice: number,
  buyDateTs: number | null
): { points: ChartPoint[] } {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { points: [] };

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const width = rect.width;
  const height = rect.height;

  const padding = { top: 25, right: 55, bottom: 30, left: 10 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const prices = candles.c;
  if (!prices || prices.length < 2) {
    ctx.fillStyle = 'rgba(128,128,128,0.65)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Not enough price history', width / 2, height / 2);
    return { points: [] };
  }

  let minPrice = Math.min(...prices);
  let maxPrice = Math.max(...prices);
  if (entryPrice > 0) {
    minPrice = Math.min(minPrice, entryPrice);
    maxPrice = Math.max(maxPrice, entryPrice);
  }
  let priceRange = maxPrice - minPrice || 1;
  minPrice -= priceRange * 0.08;
  maxPrice += priceRange * 0.08;
  priceRange = maxPrice - minPrice;

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

  if (entryPrice > 0) {
    const entryY = padding.top + chartH - ((entryPrice - minPrice) / priceRange) * chartH;
    ctx.strokeStyle = 'rgba(61, 214, 198, 0.6)';
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(padding.left, entryY);
    ctx.lineTo(width - padding.right, entryY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(61, 214, 198, 0.9)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Entry $' + fmtUiDecimal(entryPrice), width - padding.right + 4, entryY + 3);
  }

  const points: ChartPoint[] = [];
  let buyPointIdx = -1;
  const buyDateDay = buyDateTs ? new Date(buyDateTs).toDateString() : null;

  for (let i = 0; i < prices.length; i++) {
    const x = padding.left + (i / (prices.length - 1)) * chartW;
    const y = padding.top + chartH - ((prices[i] - minPrice) / priceRange) * chartH;
    const pointDate = new Date(candles.t[i] * 1000);
    points.push({ x, y, price: prices[i], date: pointDate });
    if (buyDateDay && pointDate.toDateString() === buyDateDay) buyPointIdx = i;
  }

  const lastPrice = prices[prices.length - 1];
  const firstPrice = prices[0];
  const isUp = lastPrice >= firstPrice;
  const lineColor = isUp ? 'rgba(63, 185, 80, 1)' : 'rgba(248, 81, 73, 1)';
  const fillColor = isUp ? 'rgba(63, 185, 80, 0.15)' : 'rgba(248, 81, 73, 0.15)';

  ctx.beginPath();
  ctx.moveTo(points[0].x, padding.top + chartH);
  for (const p of points) ctx.lineTo(p.x, p.y);
  ctx.lineTo(points[points.length - 1].x, padding.top + chartH);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let k = 1; k < points.length; k++) ctx.lineTo(points[k].x, points[k].y);
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  for (let m = 0; m < points.length; m++) {
    const prev = m > 0 ? prices[m - 1] : candles.o[m];
    const dotUp = prices[m] >= prev;
    ctx.beginPath();
    ctx.arc(points[m].x, points[m].y, 3, 0, Math.PI * 2);
    ctx.fillStyle = dotUp ? 'rgba(63, 185, 80, 1)' : 'rgba(248, 81, 73, 1)';
    ctx.fill();
  }

  if (buyPointIdx >= 0) {
    const bp = points[buyPointIdx];
    ctx.fillStyle = 'rgba(61, 214, 198, 1)';
    ctx.beginPath();
    ctx.arc(bp.x, bp.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(bp.x, bp.y - 6);
    ctx.lineTo(bp.x, bp.y - 22);
    ctx.strokeStyle = 'rgba(61, 214, 198, 1)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(bp.x, bp.y - 22);
    ctx.lineTo(bp.x - 6, bp.y - 28);
    ctx.lineTo(bp.x - 6, bp.y - 38);
    ctx.lineTo(bp.x + 6, bp.y - 38);
    ctx.lineTo(bp.x + 6, bp.y - 28);
    ctx.closePath();
    ctx.fillStyle = 'rgba(61, 214, 198, 1)';
    ctx.fill();

    ctx.fillStyle = '#000';
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BUY', bp.x, bp.y - 30);
  }

  ctx.fillStyle = 'rgba(128,128,128,0.7)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  for (let p = 0; p <= 4; p++) {
    const priceVal = maxPrice - (priceRange * p) / 4;
    const py = padding.top + (chartH * p) / 4;
    ctx.fillText('$' + fmtUiDecimal(priceVal), width - 4, py + 3);
  }

  ctx.textAlign = 'center';
  const labelCount = Math.min(5, points.length);
  for (let d = 0; d < labelCount; d++) {
    const idx = Math.floor((d * (points.length - 1)) / (labelCount - 1));
    const dateLabel = points[idx].date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    ctx.fillText(dateLabel, points[idx].x, height - 8);
  }

  const latestPnl = entryPrice > 0 ? ((lastPrice - entryPrice) / entryPrice) * 100 : 0;
  const pnlText = (latestPnl >= 0 ? '+' : '') + fmtUiPercent(latestPnl) + '%';
  ctx.textAlign = 'left';
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.fillStyle = isUp ? 'rgba(63, 185, 80, 1)' : 'rgba(248, 81, 73, 1)';
  ctx.fillText('$' + fmtUiDecimal(lastPrice) + ' (' + pnlText + ')', padding.left + 5, padding.top - 8);

  return { points };
}

export function drawMiniPriceChart(
  canvas: HTMLCanvasElement,
  candles: DailyCandles,
  entryPrice: number,
  buyDateTs: number | null
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const width = rect.width;
  const height = rect.height;

  const padding = { top: 8, right: 8, bottom: 8, left: 8 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const prices = candles.c;
  if (!prices || prices.length < 2) {
    ctx.fillStyle = 'rgba(128,128,128,0.5)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No history', width / 2, height / 2);
    return;
  }

  let minPrice = Math.min(...prices);
  let maxPrice = Math.max(...prices);
  if (entryPrice > 0) {
    minPrice = Math.min(minPrice, entryPrice);
    maxPrice = Math.max(maxPrice, entryPrice);
  }
  let priceRange = maxPrice - minPrice || 1;
  minPrice -= priceRange * 0.05;
  maxPrice += priceRange * 0.05;
  priceRange = maxPrice - minPrice;

  ctx.clearRect(0, 0, width, height);

  if (entryPrice > 0) {
    const entryY = padding.top + chartH - ((entryPrice - minPrice) / priceRange) * chartH;
    ctx.strokeStyle = 'rgba(61, 214, 198, 0.4)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, entryY);
    ctx.lineTo(width - padding.right, entryY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const points: ChartPoint[] = [];
  let buyPointIdx = -1;
  const buyDateDay = buyDateTs ? new Date(buyDateTs).toDateString() : null;

  for (let i = 0; i < prices.length; i++) {
    const x = padding.left + (i / (prices.length - 1)) * chartW;
    const y = padding.top + chartH - ((prices[i] - minPrice) / priceRange) * chartH;
    const pointDate = new Date(candles.t[i] * 1000);
    points.push({ x, y, price: prices[i], date: pointDate });
    if (buyDateDay && pointDate.toDateString() === buyDateDay) buyPointIdx = i;
  }

  const lastPrice = prices[prices.length - 1];
  const firstPrice = prices[0];
  const isUp = lastPrice >= firstPrice;
  const lineColor = isUp ? 'rgba(63, 185, 80, 1)' : 'rgba(248, 81, 73, 1)';
  const fillColor = isUp ? 'rgba(63, 185, 80, 0.2)' : 'rgba(248, 81, 73, 0.2)';

  ctx.beginPath();
  ctx.moveTo(points[0].x, padding.top + chartH);
  for (const p of points) ctx.lineTo(p.x, p.y);
  ctx.lineTo(points[points.length - 1].x, padding.top + chartH);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let k = 1; k < points.length; k++) ctx.lineTo(points[k].x, points[k].y);
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (buyPointIdx >= 0) {
    const bp = points[buyPointIdx];
    ctx.fillStyle = 'rgba(61, 214, 198, 1)';
    ctx.beginPath();
    ctx.arc(bp.x, bp.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const lastPt = points[points.length - 1];
  ctx.fillStyle = lineColor;
  ctx.beginPath();
  ctx.arc(lastPt.x, lastPt.y, 3, 0, Math.PI * 2);
  ctx.fill();
}
