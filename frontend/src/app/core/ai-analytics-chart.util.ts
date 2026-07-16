export type AiChartMetric = 'requests' | 'tokens' | 'cost';

export interface AiChartRow {
  label: string;
  requests: number;
  tokens: number;
  cost: number;
}

const PALETTE = ['#58a6ff', '#3dd6c6', '#f0883e', '#a371f7', '#ff7b72', '#d2a8ff'];

export function metricValue(row: AiChartRow, metric: AiChartMetric): number {
  return row[metric] ?? 0;
}

export function formatMetric(v: number, metric: AiChartMetric): string {
  if (metric === 'cost') return '$' + v.toFixed(4);
  if (metric === 'tokens') return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v));
  return String(Math.round(v));
}

function setupCanvas(canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
} | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function drawEmpty(ctx: CanvasRenderingContext2D, width: number, height: number, msg: string): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(139, 148, 158, 0.85)';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, width / 2, height / 2);
}

export function drawAiDonutChart(
  canvas: HTMLCanvasElement,
  rows: AiChartRow[],
  metric: AiChartMetric
): string[] {
  const setup = setupCanvas(canvas);
  if (!setup) return [];
  const { ctx, width, height } = setup;
  const values = rows.map((r) => Math.max(0, metricValue(r, metric)));
  const total = values.reduce((a, b) => a + b, 0);
  if (!rows.length || total <= 0) {
    drawEmpty(ctx, width, height, 'No data');
    return [];
  }

  ctx.clearRect(0, 0, width, height);
  const cx = width * 0.38;
  const cy = height * 0.5;
  const outerR = Math.min(width * 0.28, height * 0.38);
  const innerR = outerR * 0.58;
  let start = -Math.PI / 2;

  rows.forEach((row, i) => {
    const v = Math.max(0, metricValue(row, metric));
    if (v <= 0) return;
    const slice = (v / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, start, start + slice);
    ctx.arc(cx, cy, innerR, start + slice, start, true);
    ctx.closePath();
    ctx.fillStyle = PALETTE[i % PALETTE.length];
    ctx.fill();
    start += slice;
  });

  ctx.fillStyle = '#e6edf3';
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatMetric(total, metric), cx, cy - 6);
  ctx.fillStyle = 'rgba(139, 148, 158, 0.95)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText(metric, cx, cy + 10);

  const colors: string[] = [];
  const legendX = width * 0.62;
  let ly = height * 0.22;
  rows.forEach((row, i) => {
    const color = PALETTE[i % PALETTE.length];
    colors.push(color);
    const v = metricValue(row, metric);
    const pct = total > 0 ? ((v / total) * 100).toFixed(0) : '0';
    ctx.fillStyle = color;
    ctx.fillRect(legendX, ly - 8, 10, 10);
    ctx.fillStyle = '#e6edf3';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${row.label} · ${formatMetric(v, metric)} (${pct}%)`, legendX + 16, ly - 2);
    ly += 22;
  });
  return colors;
}

export function drawAiBarChart(
  canvas: HTMLCanvasElement,
  rows: AiChartRow[],
  metric: AiChartMetric,
  orientation: 'horizontal' | 'vertical'
): string[] {
  const setup = setupCanvas(canvas);
  if (!setup) return [];
  const { ctx, width, height } = setup;
  if (!rows.length) {
    drawEmpty(ctx, width, height, 'No data');
    return [];
  }

  const values = rows.map((r) => Math.max(0, metricValue(r, metric)));
  const max = Math.max(...values, 1e-9);
  const colors: string[] = rows.map((_, i) => PALETTE[i % PALETTE.length]);

  ctx.clearRect(0, 0, width, height);
  const pad = { top: 14, right: 52, bottom: orientation === 'vertical' ? 36 : 14, left: orientation === 'horizontal' ? 72 : 14 };

  if (orientation === 'horizontal') {
    const chartW = width - pad.left - pad.right;
    const barH = Math.min(28, (height - pad.top - pad.bottom) / rows.length - 8);
    const gap = 8;
    let y = pad.top;

    ctx.strokeStyle = 'rgba(139, 148, 158, 0.2)';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const gx = pad.left + (chartW * g) / 4;
      ctx.beginPath();
      ctx.moveTo(gx, pad.top);
      ctx.lineTo(gx, height - pad.bottom);
      ctx.stroke();
    }

    rows.forEach((row, i) => {
      const v = values[i];
      const w = (v / max) * chartW;
      const color = colors[i];
      ctx.fillStyle = color;
      ctx.fillRect(pad.left, y, Math.max(2, w), barH);
      ctx.fillStyle = '#e6edf3';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(row.label.slice(0, 12), pad.left - 8, y + barH / 2);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(230, 237, 243, 0.9)';
      ctx.fillText(formatMetric(v, metric), pad.left + w + 6, y + barH / 2);
      y += barH + gap;
    });
    return colors;
  }

  const chartH = height - pad.top - pad.bottom;
  const chartW = width - pad.left - pad.right;
  const barW = Math.min(48, chartW / rows.length - 12);
  const gap = Math.max(8, (chartW - barW * rows.length) / (rows.length + 1));
  let x = pad.left + gap;

  ctx.strokeStyle = 'rgba(139, 148, 158, 0.2)';
  for (let g = 0; g <= 4; g++) {
    const gy = pad.top + (chartH * g) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, gy);
    ctx.lineTo(width - pad.right, gy);
    ctx.stroke();
  }

  rows.forEach((row, i) => {
    const v = values[i];
    const h = (v / max) * chartH;
    const color = colors[i];
    const bx = x;
    const by = pad.top + chartH - h;
    ctx.fillStyle = color;
    ctx.fillRect(bx, by, barW, Math.max(2, h));
    ctx.save();
    ctx.translate(bx + barW / 2, height - pad.bottom + 4);
    ctx.rotate(-0.45);
    ctx.fillStyle = 'rgba(139, 148, 158, 0.95)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    const label = row.label.length > 10 ? row.label.slice(5) : row.label;
    ctx.fillText(label, 0, 0);
    ctx.restore();
    ctx.fillStyle = 'rgba(230, 237, 243, 0.9)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatMetric(v, metric), bx + barW / 2, by - 4);
    x += barW + gap;
  });
  return colors;
}
