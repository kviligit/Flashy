/**
 * Small inline-SVG charts. No dependencies, theme-aware by using CSS
 * custom properties for every colour, so a token change restyles them.
 */

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

export interface Series {
  label: string;
  /** A CSS colour, usually `var(--token)`. */
  colour: string;
  values: number[];
}

export interface BarChartOptions {
  /** One label per column; may be sparse for readability. */
  labels: string[];
  series: Series[];
  height?: number;
  /** Show every nth x-axis label. */
  labelEvery?: number;
  /** Formatter for the value shown in a column's tooltip. */
  formatValue?: (total: number, index: number) => string;
}

/**
 * A stacked bar chart.
 *
 * The viewBox is a fixed 640-unit canvas whatever the column count, and the
 * SVG scales uniformly into its container. Stretching it non-uniformly
 * would be simpler but would squash the axis labels, so column width shrinks
 * with the data instead.
 */
export function stackedBarChart(options: BarChartOptions): SVGElement {
  const { labels, series } = options;
  const columns = labels.length;
  const height = options.height ?? 160;
  const width = 640;
  const padLeft = 34;
  const padBottom = 18;
  const padTop = 6;
  const plotHeight = height - padBottom - padTop;
  const plotWidth = width - padLeft;

  const totals = Array.from({ length: columns }, (_, i) =>
    series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  );
  const max = Math.max(1, ...totals);
  const scale = (value: number) => (value / max) * plotHeight;
  const columnWidth = plotWidth / Math.max(columns, 1);
  const barWidth = Math.max(1, columnWidth * 0.76);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    style: 'width:100%;height:auto;display:block',
  });

  // Horizontal guides at 0, half and full scale.
  for (const fraction of [0, 0.5, 1]) {
    const y = padTop + plotHeight - plotHeight * fraction;
    svg.appendChild(
      svgEl('line', {
        x1: padLeft,
        x2: width,
        y1: y,
        y2: y,
        stroke: 'var(--border)',
        'stroke-width': 1,
      }),
    );
    const label = svgEl('text', {
      x: padLeft - 6,
      y: y + 4,
      'text-anchor': 'end',
      fill: 'var(--text-faint)',
      'font-size': 10,
    });
    label.textContent = String(Math.round(max * fraction));
    svg.appendChild(label);
  }

  for (let i = 0; i < columns; i++) {
    let y = padTop + plotHeight;
    for (const s of series) {
      const value = s.values[i] ?? 0;
      if (value <= 0) continue;
      const barHeight = scale(value);
      y -= barHeight;
      svg.appendChild(
        svgEl('rect', {
          x: padLeft + i * columnWidth + (columnWidth - barWidth) / 2,
          y,
          width: barWidth,
          height: barHeight,
          fill: s.colour,
          rx: 1,
        }),
      );
    }

    // A full-height transparent hit area, so hovering anywhere in the
    // column shows its tooltip even where the bar is short.
    const hit = svgEl('rect', {
      x: padLeft + i * columnWidth,
      y: padTop,
      width: columnWidth,
      height: plotHeight,
      fill: 'transparent',
    });
    const title = svgEl('title');
    title.textContent = options.formatValue
      ? options.formatValue(totals[i]!, i)
      : `${labels[i]}: ${totals[i]}`;
    hit.appendChild(title);
    svg.appendChild(hit);
  }

  const every = options.labelEvery ?? Math.max(1, Math.ceil(columns / 10));
  for (let i = 0; i < columns; i++) {
    if (i % every !== 0 && i !== columns - 1) continue;

    // The first and last labels are anchored inward, or they would hang off
    // the edges of the viewBox and be clipped.
    const first = i === 0;
    const last = i === columns - 1;
    const anchor = first ? 'start' : last ? 'end' : 'middle';
    const x = first
      ? padLeft
      : last
        ? width
        : padLeft + i * columnWidth + columnWidth / 2;

    const text = svgEl('text', {
      x,
      y: height - 5,
      'text-anchor': anchor,
      fill: 'var(--text-faint)',
      'font-size': 10,
    });
    text.textContent = labels[i] ?? '';
    svg.appendChild(text);
  }

  return svg;
}

/** A single horizontal bar split into proportional segments. */
export function proportionBar(
  parts: Array<{ label: string; value: number; colour: string }>,
  height = 12,
): SVGElement {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  const svg = svgEl('svg', {
    viewBox: `0 0 100 ${height}`,
    preserveAspectRatio: 'none',
    role: 'img',
    style: `width:100%;height:${height}px;display:block`,
  });

  if (total === 0) {
    svg.appendChild(
      svgEl('rect', { x: 0, y: 0, width: 100, height, fill: 'var(--surface-3)', rx: 2 }),
    );
    return svg;
  }

  let x = 0;
  for (const part of parts) {
    if (part.value <= 0) continue;
    const w = (part.value / total) * 100;
    const rect = svgEl('rect', { x, y: 0, width: w, height, fill: part.colour });
    const title = svgEl('title');
    title.textContent = `${part.label}: ${part.value} (${((part.value / total) * 100).toFixed(0)}%)`;
    rect.appendChild(title);
    svg.appendChild(rect);
    x += w;
  }

  return svg;
}
