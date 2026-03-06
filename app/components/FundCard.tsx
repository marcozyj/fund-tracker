'use client';

import type { FundData, Holding } from '../../lib/types';
import { classByValue, formatPct } from '../../lib/utils';
import { trendState, resolveDailyPct } from '../../lib/metrics';

export default function FundCard({
  variant,
  code,
  data,
  holding,
  isHolding,
  className,
  style,
  onOpen
}: {
  variant: 'holding' | 'watchlist';
  code: string;
  data?: FundData;
  holding?: Holding;
  isHolding?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onOpen: () => void;
}) {
  const metrics = data ? data.metrics : null;
  const stateTag = trendState(metrics);
  const dailyPct = resolveDailyPct(data);
  const estClass = dailyPct !== null ? classByValue(dailyPct) : '';
  const recentClass = metrics ? classByValue(metrics.recent) : '';
  const cumulativeClass = metrics ? classByValue(metrics.cumulative) : '';
  const ddClass = metrics ? classByValue(metrics.maxDrawdown) : '';
  const volClass = metrics ? classByValue(metrics.volatility) : '';

  if (variant === 'holding' && holding) {
    return (
      <div className={`fund-card clickable ${className || ''}`.trim()} style={style} onClick={onOpen}>
        <div className="fund-tile-name">{data ? data.name : holding.code}</div>
        <div className="fund-tile-pct">{dailyPct !== null && dailyPct !== undefined ? formatPct(dailyPct) : '--'}</div>
      </div>
    );
  }

  return (
    <div className={`fund-card clickable ${className || ''}`.trim()} style={style} onClick={onOpen}>
      <div className="fund-title">
        <div>
          <h4>{data ? data.name : code}</h4>
          <div className="fund-code">{code}</div>
        </div>
        <div className="fund-title-meta">
          <div className={`status ${stateTag.cls}`}>{stateTag.label}</div>
          <span className="badge">{isHolding ? '持仓' : '自选'}</span>
        </div>
      </div>
      <div className="fund-meta">
        <div className="meta-block">
          <span>最新净值</span>
          <strong>{data ? data.latestNav?.toFixed(4) ?? '--' : '--'}</strong>
        </div>
        <div className="meta-block">
          <span>估值变动（参考）</span>
          <strong className={estClass}>{dailyPct !== null ? formatPct(dailyPct) : '--'}</strong>
        </div>
      </div>
      <div className="fund-metrics">
        <div className="metric">
          <span>近 60 日</span>
          <strong className={recentClass}>{formatPct(metrics ? metrics.recent : null)}</strong>
        </div>
        <div className="metric">
          <span>累计收益</span>
          <strong className={cumulativeClass}>{formatPct(metrics ? metrics.cumulative : null)}</strong>
        </div>
        <div className="metric">
          <span>最大回撤</span>
          <strong className={ddClass}>{formatPct(metrics ? metrics.maxDrawdown : null)}</strong>
        </div>
        <div className="metric">
          <span>波动率</span>
          <strong className={volClass}>{metrics ? metrics.volatility.toFixed(2) + '%' : '--'}</strong>
        </div>
      </div>
    </div>
  );
}
