export type AiChartMetric = 'requests' | 'tokens' | 'cost';

export interface AiChartRow {
  label: string;
  requests: number;
  tokens: number;
  cost: number;
}

export interface AiChartHit {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  value: string;
}

export interface AiChartDrawResult {
  colors: string[];
  hits: AiChartHit[];
}

const PALETTE = ['#58a6ff', '#3dd6c6', '#f0883e', '#a371f7', '#ff7b72', '#d2a8ff'];
const BAR_FILL = '#58a6ff';

export function metricValue(row: AiChartRow, metric: AiChartMetric): number {
  return row[metric] ?? 0;
}

export function formatMetric(v: number, metric: AiChartMetric): string {
  if (metric === 'cost') return '$' + v.toFixed(4);
  if (metric === 'tokens') return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v));
  return String(Math.round(v));
}

export function shortDayLabel(label: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(label);
  return m ? `${m[2]}-${m[3]}` : label;
}

export function limitChartRows(
  rows: AiChartRow[],
  topN: number,
  metric: AiChartMetric
): AiChartRow[] {
  if (topN <= 0 || rows.length <= topN) return rows;
  const sorted = [...rows].sort((a, b) => metricValue(b, metric) - metricValue(a, metric));
  const head = sorted.slice(0, topN);
  const tail = sorted.slice(topN);
  if (!tail.length) return head;
  return [
    ...head,
    {
      label: `Other (${tail.length})`,
      requests: tail.reduce((s, r) => s + r.requests, 0),
      tokens: tail.reduce((s, r) => s + r.tokens, 0),
      cost: tail.reduce((s, r) => s + r.cost, 0),
    },
  ];
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

function labelIndices(n: number, maxLabels: number): Set<number> {
  const out = new Set<number>();
  if (n <= 0) return out;
  const count = Math.min(n, Math.max(2, maxLabels));
  if (n <= count) {
    for (let i = 0; i < n; i++) out.add(i);
    return out;
  }
  out.add(0);
  out.add(n - 1);
  const inner = count - 2;
  for (let k = 1; k <= inner; k++) {
    out.add(Math.round((k * (n - 1)) / (inner + 1)));
  }
  return out;
}

export function drawAiDonutChart(
  canvas: HTMLCanvasElement,
  rows: AiChartRow[],
  metric: AiChartMetric
): AiChartDrawResult {
  const setup = setupCanvas(canvas);
  if (!setup) return { colors: [], hits: [] };
  const { ctx, width, height } = setup;
  const values = rows.map((r) => Math.max(0, metricValue(r, metric)));
  const total = values.reduce((a, b) => a + b, 0);
  if (!rows.length || total <= 0) {
    drawEmpty(ctx, width, height, 'No data');
    return { colors: [], hits: [] };
  }

  ctx.clearRect(0, 0, width, height);
  const cx = width * 0.5;
  const cy = height * 0.5;
  const outerR = Math.min(width, height) * 0.38;
  const innerR = outerR * 0.62;
  let start = -Math.PI / 2;
  const colors: string[] = [];
  const hits: AiChartHit[] = [];

  rows.forEach((row, i) => {
    const v = Math.max(0, metricValue(row, metric));
    if (v <= 0) return;
    const slice = (v / total) * Math.PI * 2;
    const color = PALETTE[i % PALETTE.length];
    colors.push(color);
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, start, start + slice);
    ctx.arc(cx, cy, innerR, start + slice, start, true);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    hits.push({
      x: cx - outerR,
      y: cy - outerR,
      w: outerR * 2,
      h: outerR * 2,
      label: row.label,
      value: `${formatMetric(v, metric)} (${((v / total) * 100).toFixed(0)}%)`,
    });
    start += slice;
  });

  ctx.fillStyle = '#e6edf3';
  ctx.font = '600 15px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatMetric(total, metric), cx, cy - 8);
  ctx.fillStyle = 'rgba(139, 148, 158, 0.95)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(metric, cx, cy + 10);
  return { colors, hits };
}

export function drawAiBarChart(
  canvas: HTMLCanvasElement,
  rows: AiChartRow[],
  metric: AiChartMetric,
  orientation: 'horizontal' | 'vertical'
): AiChartDrawResult {
  const setup = setupCanvas(canvas);
  if (!setup) return { colors: [], hits: [] };
  const { ctx, width, height } = setup;
  if (!rows.length) {
    drawEmpty(ctx, width, height, 'No data');
    return { colors: [], hits: [] };
  }

  const values = rows.map((r) => Math.max(0, metricValue(r, metric)));
  const max = Math.max(...values, 1e-9);
  const colors: string[] = rows.map((_, i) =>
    orientation === 'vertical' ? BAR_FILL : PALETTE[i % PALETTE.length]
  );
  const hits: AiChartHit[] = [];

  ctx.clearRect(0, 0, width, height);

  if (orientation === 'horizontal') {
    const pad = { top: 8, right: 72, bottom: 8, left: 92 };
    const chartW = width - pad.left - pad.right;
    const slot = (height - pad.top - pad.bottom) / rows.length;
    const barH = Math.min(22, Math.max(10, slot * 0.62));

    ctx.strokeStyle = 'rgba(139, 148, 158, 0.18)';
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
      const y = pad.top + i * slot + (slot - barH) / 2;
      ctx.fillStyle = colors[i];
      ctx.fillRect(pad.left, y, Math.max(2, w), barH);
      ctx.fillStyle = '#e6edf3';
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const label = row.label.length > 12 ? row.label.slice(0, 11) + '…' : row.label;
      ctx.fillText(label, pad.left - 8, y + barH / 2);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(230, 237, 243, 0.85)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(formatMetric(v, metric), pad.left + w + 6, y + barH / 2);
      hits.push({
        x: pad.left,
        y,
        w: Math.max(2, w),
        h: barH,
        label: row.label,
        value: formatMetric(v, metric),
      });
    });
    return { colors, hits };
  }

  const pad = { top: 18, right: 12, bottom: 28, left: 12 };
  const chartH = height - pad.top - pad.bottom;
  const chartW = width - pad.left - pad.right;
  const slot = chartW / rows.length;
  const barW = Math.min(28, Math.max(3, slot * 0.62));
  const showValues = rows.length <= 14;
  const labeled = labelIndices(rows.length, Math.min(8, rows.length));

  ctx.strokeStyle = 'rgba(139, 148, 158, 0.18)';
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
    const bx = pad.left + i * slot + (slot - barW) / 2;
    const by = pad.top + chartH - h;
    ctx.fillStyle = colors[i];
    ctx.fillRect(bx, by, barW, Math.max(2, h));
    hits.push({
      x: bx,
      y: by,
      w: barW,
      h: Math.max(2, h),
      label: row.label,
      value: formatMetric(v, metric),
    });
    if (showValues && v > 0) {
      ctx.fillStyle = 'rgba(230, 237, 243, 0.8)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(formatMetric(v, metric), bx + barW / 2, by - 3);
    }
    if (labeled.has(i)) {
      ctx.fillStyle = 'rgba(139, 148, 158, 0.95)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(shortDayLabel(row.label), bx + barW / 2, height - pad.bottom + 6);
    }
  });
  return { colors, hits };
}
