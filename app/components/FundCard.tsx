'use client';

import type { FundData, Holding } from '../../lib/types';
import { classByValue, formatMoney, formatMoneyWithSymbol, formatNumber, formatPct } from '../../lib/utils';
import { computeHoldingView, trendState } from '../../lib/metrics';

export default function FundCard({
  variant,
  code,
  data,
  holding,
  isHolding,
  onOpen
}: {
  variant: 'holding' | 'watchlist';
  code: string;
  data?: FundData;
  holding?: Holding;
  isHolding?: boolean;
  onOpen: () => void;
}) {
  const metrics = data ? data.metrics : null;
  const stateTag = trendState(metrics);
  const estClass = data && data.estPct !== null ? classByValue(data.estPct) : '';
  const recentClass = metrics ? classByValue(metrics.recent) : '';
  const cumulativeClass = metrics ? classByValue(metrics.cumulative) : '';
  const ddClass = metrics ? classByValue(metrics.maxDrawdown) : '';
  const volClass = metrics ? classByValue(metrics.volatility) : '';

  const dailyPct = deriveDailyPct(data);

  if (variant === 'holding' && holding) {
    const view = computeHoldingView(holding, data);
    const profitValue = view.profit;
    const profitClass = classByValue(profitValue);
    const dailyProfit = view.amount !== null && dailyPct !== null ? (view.amount * dailyPct) / 100 : null;
    const dailyClass = classByValue(dailyProfit);
    const dailyRateClass = classByValue(dailyPct);
    const holdingRate =
      view.amount !== null &&
      view.amount !== undefined &&
      profitValue !== null &&
      profitValue !== undefined &&
      view.amount - profitValue !== 0
        ? (profitValue / (view.amount - profitValue)) * 100
        : null;
    const holdingRateClass = classByValue(holdingRate);
    const holdingShares =
      holding.shares !== null && holding.shares !== undefined
        ? holding.shares
        : view.amount !== null && view.amount !== undefined && data?.latestNav
          ? view.amount / data.latestNav
          : null;

    return (
      <div className="fund-card clickable" onClick={onOpen}>
        <div className="fund-title">
          <div>
            <h4>{data ? data.name : holding.code}</h4>
            <div className="fund-code">{holding.code}</div>
          </div>
          <div className="fund-title-meta">
            <div className={`status ${stateTag.cls}`}>{stateTag.label}</div>
          </div>
        </div>
        <div className="holding-layout">
          <div className="holding-left">
            <span>持有金额</span>
            <strong>{formatMoneyWithSymbol(view.amount)}</strong>
            <div className="holding-sub-row">
              <em className="holding-sub">
                持有份额 {holdingShares !== null && holdingShares !== undefined ? formatNumber(holdingShares, 2) : '--'}
              </em>
              <em className="holding-sub">
                持仓成本价 {view.costUnit !== null && view.costUnit !== undefined ? formatNumber(view.costUnit, 4) : '--'}
              </em>
            </div>
          </div>
          <div className="holding-right">
            <div className="holding-row">
              <div className="holding-main">
                <span>当日收益</span>
                <strong className={dailyClass}>{dailyProfit === null ? '--' : formatMoney(dailyProfit)}</strong>
              </div>
              <div className={`holding-rate ${dailyRateClass}`}>{formatPct(dailyPct ?? null)}</div>
            </div>
            <div className="holding-row">
              <div className="holding-main">
                <span>持有收益</span>
                <strong className={profitClass}>{formatMoney(profitValue)}</strong>
              </div>
              <div className={`holding-rate ${holdingRateClass}`}>{formatPct(holdingRate)}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fund-card clickable" onClick={onOpen}>
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
          <strong className={estClass}>{data && data.estPct !== null ? formatPct(data.estPct) : '--'}</strong>
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

function deriveDailyPct(data?: FundData) {
  if (!data) return null;
  if (typeof data.estPct === 'number' && Number.isFinite(data.estPct)) return data.estPct;
  const history = Array.isArray(data.history) ? data.history : [];
  if (!history.length) return null;
  const last = history[history.length - 1];
  if (typeof last.daily_growth_rate === 'number' && Number.isFinite(last.daily_growth_rate)) {
    return last.daily_growth_rate;
  }
  if (history.length < 2) return null;
  const prev = history[history.length - 2]?.nav ?? null;
  if (!prev) return null;
  return ((last.nav / prev) - 1) * 100;
}
