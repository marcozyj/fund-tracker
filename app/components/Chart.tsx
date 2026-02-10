'use client';

import { useEffect, useRef } from 'react';
import type { ChartMarker, ChartRange, FundHistoryPoint } from '../../lib/types';
import { formatNumber, formatPct } from '../../lib/utils';

const rangeToCount = (range: ChartRange) => {
  switch (range) {
    case '1y':
      return 252;
    case '6m':
      return 126;
    case '1m':
      return 21;
    default:
      return 180;
  }
};

export default function Chart({
  history,
  range,
  markers = []
}: {
  history: FundHistoryPoint[];
  range: ChartRange;
  markers?: ChartMarker[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    buildChart(containerRef.current, history || [], rangeToCount(range), markers);
  }, [history, range, markers]);

  return <div className="chart detail-chart" ref={containerRef} />;
}

function buildChart(container: HTMLDivElement, history: FundHistoryPoint[], rangeCount: number, markers: ChartMarker[]) {
  if (!container) return;
  if (!history || history.length < 2) {
    container.innerHTML = '<div class="empty-state">暂无可视化数据</div>';
    return;
  }

  const points = history.slice(-(rangeCount || 180));
  const values = points.map((item) => item.nav);
  const dates = points.map((item) => item.date);
  const width = 640;
  const height = 220;
  const padding = { top: 16, right: 20, bottom: 30, left: 46 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const chartId = `chart-${Math.random().toString(36).slice(2, 8)}`;
  const areaId = `${chartId}-area`;

  const coords = values.map((v, i) => {
    const x = padding.left + (i / (values.length - 1)) * plotWidth;
    const y = padding.top + (1 - (v - min) / range) * plotHeight;
    return { x, y, v, date: dates[i] };
  });

  const path = coords
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(' ');
  const areaPath = `${path} L${padding.left + plotWidth},${padding.top + plotHeight} L${padding.left},${padding.top + plotHeight} Z`;

  const yTickCount = 5;
  const yTicks = Array.from({ length: yTickCount }, (_, i) => min + (range * i) / (yTickCount - 1));
  const yTickLines = yTicks
    .map((tick) => {
      const y = padding.top + (1 - (tick - min) / range) * plotHeight;
      return `<line class="grid-line" x1="${padding.left}" y1="${y.toFixed(2)}" x2="${padding.left + plotWidth}" y2="${y.toFixed(2)}" />`;
    })
    .join('');

  const yTickLabels = yTicks
    .map((tick) => {
      const y = padding.top + (1 - (tick - min) / range) * plotHeight;
      return `<text x="${padding.left - 8}" y="${y.toFixed(2)}" text-anchor="end" dominant-baseline="middle">${formatNumber(tick, 4)}</text>`;
    })
    .join('');

  const xTickCount = 7;
  const rawXTickIndex = Array.from({ length: xTickCount }, (_, i) =>
    Math.round((i * (coords.length - 1)) / (xTickCount - 1))
  );
  const xTickIndex = Array.from(new Set(rawXTickIndex)).filter((idx) => idx >= 0 && idx < coords.length);
  const xTickLabelY = padding.top + plotHeight + 16;

  const xTickLabels = xTickIndex
    .map((idx) => {
      const point = coords[idx];
      const label = point.date ? point.date.slice(5) : '';
      return `<text x="${point.x.toFixed(2)}" y="${xTickLabelY}" text-anchor="middle">${label}</text>`;
    })
    .join('');

  const segments: { dir: string; d: string }[] = [];
  let currentDir: string | null = null;
  let currentPath = '';

  for (let i = 0; i < coords.length; i += 1) {
    const point = coords[i];
    if (i === 0) {
      currentPath = `M${point.x.toFixed(2)},${point.y.toFixed(2)}`;
      continue;
    }
    const prevPoint = coords[i - 1];
    const diff = point.v - prevPoint.v;
    const dir = diff >= 0 ? 'up' : 'down';
    if (!currentDir) currentDir = dir;
    if (dir !== currentDir) {
      segments.push({ dir: currentDir, d: currentPath });
      currentDir = dir;
      currentPath = `M${prevPoint.x.toFixed(2)},${prevPoint.y.toFixed(2)} L${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    } else {
      currentPath += ` L${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    }
  }
  if (currentPath) {
    segments.push({ dir: currentDir || 'flat', d: currentPath });
  }

  const linePaths = segments
    .map((segment) => `<path class="line-path ${segment.dir} animate" d="${segment.d}" pathLength="1" />`)
    .join('');

  const markerDots = (() => {
    if (!markers || !markers.length) return '';
    const dateIndex = new Map<string, number>();
    coords.forEach((point, idx) => {
      if (point.date) dateIndex.set(point.date, idx);
    });

    const resolveIndex = (date: string) => {
      if (!date) return null;
      const direct = dateIndex.get(date);
      if (direct !== undefined) return direct;
      let idx = -1;
      for (let i = 0; i < coords.length; i += 1) {
        if (coords[i].date && coords[i].date <= date) {
          idx = i;
        } else {
          break;
        }
      }
      return idx >= 0 ? idx : null;
    };

    return markers
      .map((marker, idx) => {
        if (!marker.date || !coords.length) return '';
        const firstDate = coords[0].date || '';
        const lastDate = coords[coords.length - 1].date || '';
        if (firstDate && marker.date < firstDate) return '';
        if (lastDate && marker.date > lastDate) return '';
        const pointIndex = resolveIndex(marker.date);
        if (pointIndex === null) return '';
        const point = coords[pointIndex];
        const cls = marker.type === 'add' ? 'add' : 'reduce';
        return `<circle class="trade-dot ${cls}" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(
          2
        )}" r="3" />`;
      })
      .join('');
  })();

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="${areaId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2f6fec" stop-opacity="0.25" />
          <stop offset="100%" stop-color="#2f6fec" stop-opacity="0.02" />
        </linearGradient>
      </defs>
      ${yTickLines}
      <line class="axis-line" x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + plotHeight}" />
      <line class="axis-line" x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${padding.left + plotWidth}" y2="${padding.top + plotHeight}" />
      <path class="line-area animate" d="${areaPath}" fill="url(#${areaId})" />
      ${linePaths}
      ${markerDots}
      ${yTickLabels}
      ${xTickLabels}
      <line class="axis-line chart-guide" x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + plotHeight}" opacity="0" stroke-dasharray="4 4" />
      <circle class="active-dot" cx="${padding.left}" cy="${padding.top}" r="4" opacity="0" />
    </svg>
    <div class="chart-tooltip"></div>
  `;

  const svg = container.querySelector('svg');
  const tooltip = container.querySelector('.chart-tooltip') as HTMLDivElement | null;
  const guide = container.querySelector('.chart-guide') as SVGLineElement | null;
  const dot = container.querySelector('.active-dot') as SVGCircleElement | null;
  if (tooltip) {
    tooltip.innerHTML = '<strong></strong><div class="tooltip-nav"></div><div class="tooltip-change"></div>';
  }
  const tipDate = tooltip ? (tooltip.querySelector('strong') as HTMLElement | null) : null;
  const tipNav = tooltip ? (tooltip.querySelector('.tooltip-nav') as HTMLElement | null) : null;
  const tipChange = tooltip ? (tooltip.querySelector('.tooltip-change') as HTMLElement | null) : null;

  let dotPos = { x: coords[0].x, y: coords[0].y };
  let target: { x: number; y: number } | null = null;
  let animating = false;
  let currentPoint: { x: number; y: number; v: number; date: string } | null = null;
  let rafId: number | null = null;
  let pendingMove: { clientX: number; clientY: number } | null = null;
  const smoothHover = coords.length <= 180;
  let lastIndex: number | null = null;
  let svgRect: DOMRect | null = null;
  let containerRect: DOMRect | null = null;

  function updateRects() {
    if (!svg || !container) return;
    svgRect = svg.getBoundingClientRect();
    containerRect = container.getBoundingClientRect();
  }

  function updateOverlayPosition() {
    if (!svg || !tooltip || !dotPos) return;
    if (!svgRect || !containerRect) updateRects();
    if (!svgRect || !containerRect) return;
    const displayX = (dotPos.x / width) * svgRect.width + (svgRect.left - containerRect.left);
    const displayY = (dotPos.y / height) * svgRect.height + (svgRect.top - containerRect.top);
    tooltip.style.left = `${displayX}px`;
    tooltip.style.top = `${displayY}px`;
  }

  function animateDot() {
    if (!animating || !target) return;
    const dx = target.x - dotPos.x;
    const dy = target.y - dotPos.y;
    const easing = 0.22;
    dotPos.x += dx * easing;
    dotPos.y += dy * easing;

    if (dot) {
      dot.setAttribute('cx', `${dotPos.x}`);
      dot.setAttribute('cy', `${dotPos.y}`);
    }
    if (guide) {
      guide.setAttribute('x1', `${dotPos.x}`);
      guide.setAttribute('x2', `${dotPos.x}`);
    }
    updateOverlayPosition();

    if (Math.abs(dx) + Math.abs(dy) < 0.4) {
      dotPos = { x: target.x, y: target.y };
      if (dot) {
        dot.setAttribute('cx', `${dotPos.x}`);
        dot.setAttribute('cy', `${dotPos.y}`);
      }
      if (guide) {
        guide.setAttribute('x1', `${dotPos.x}`);
        guide.setAttribute('x2', `${dotPos.x}`);
      }
      updateOverlayPosition();
      if (!currentPoint) {
        animating = false;
        return;
      }
    }
    requestAnimationFrame(animateDot);
  }

  function applyMove(event: { clientX: number; clientY: number }) {
    if (!svg) return;
    if (!svgRect) updateRects();
    if (!svgRect) return;
    const scaleX = width / svgRect.width;
    const rawX = (event.clientX - svgRect.left) * scaleX;
    const clampedX = Math.min(Math.max(rawX, padding.left), padding.left + plotWidth);
    const ratio = (clampedX - padding.left) / plotWidth;
    const index = Math.round(ratio * (coords.length - 1));
    const safeIndex = Math.max(0, Math.min(coords.length - 1, index));
    if (safeIndex === lastIndex) return;
    lastIndex = safeIndex;
    const point = coords[safeIndex];
    currentPoint = point;

    if (guide) {
      guide.setAttribute('y1', `${padding.top}`);
      guide.setAttribute('y2', `${padding.top + plotHeight}`);
      guide.setAttribute('opacity', '0.5');
    }

    if (dot) {
      dot.setAttribute('opacity', '1');
    }

    const prev = safeIndex > 0 ? coords[safeIndex - 1].v : null;
    const daily = prev ? ((point.v / prev - 1) * 100) : null;
    const trendClass = daily === null ? 'flat' : daily >= 0 ? 'up' : 'down';
    if (dot) {
      dot.setAttribute('class', `active-dot ${trendClass}`);
    }
    if (tipDate) tipDate.textContent = point.date || '';
    if (tipNav) tipNav.textContent = `净值 ${formatNumber(point.v, 4)}`;
    if (tipChange) {
      tipChange.textContent = daily !== null ? `日涨跌 ${formatPct(daily)}` : '';
      tipChange.className = `tooltip-change ${trendClass}`;
    }
    if (tooltip) tooltip.style.display = 'block';

    target = { x: point.x, y: point.y };
    if (!smoothHover) {
      dotPos = { x: target.x, y: target.y };
      if (dot) {
        dot.setAttribute('cx', `${dotPos.x}`);
        dot.setAttribute('cy', `${dotPos.y}`);
      }
      if (guide) {
        guide.setAttribute('x1', `${dotPos.x}`);
        guide.setAttribute('x2', `${dotPos.x}`);
      }
      updateOverlayPosition();
      animating = false;
      return;
    }

    if (!animating) {
      animating = true;
      requestAnimationFrame(animateDot);
    }
  }

  function handleMove(event: MouseEvent) {
    pendingMove = { clientX: event.clientX, clientY: event.clientY };
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (!pendingMove) return;
      const move = pendingMove;
      pendingMove = null;
      applyMove(move);
    });
  }

  function handleLeave() {
    if (tooltip) tooltip.style.display = 'none';
    if (dot) dot.setAttribute('opacity', '0');
    if (guide) guide.setAttribute('opacity', '0');
    currentPoint = null;
    target = null;
    animating = false;
    lastIndex = null;
    pendingMove = null;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  container.onmousemove = handleMove;
  container.onmouseenter = () => {
    updateRects();
    lastIndex = null;
  };
  container.onmouseleave = handleLeave;
}
