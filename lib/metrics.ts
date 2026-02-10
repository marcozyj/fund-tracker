import type { FundHistoryPoint, FundMetrics, Holding, FundData, TrendState } from './types';
import { toNumber } from './utils';

export function computeMetrics(history: FundHistoryPoint[]): FundMetrics | null {
  if (!history || history.length < 2) return null;
  const returns: number[] = [];
  for (let i = 1; i < history.length; i += 1) {
    const r = (history[i].nav - history[i - 1].nav) / history[i - 1].nav;
    returns.push(r);
  }
  const cumulative = (history[history.length - 1].nav / history[0].nav - 1) * 100;
  const lookback = Math.min(60, history.length - 1);
  const baseIndex = history.length - 1 - lookback;
  const recent = (history[history.length - 1].nav / history[baseIndex].nav - 1) * 100;
  const yearLookback = Math.min(252, history.length - 1);
  const yearIndex = history.length - 1 - yearLookback;
  const yearBase = history[yearIndex]?.nav ?? 0;
  const oneYear = yearBase ? (history[history.length - 1].nav / yearBase - 1) * 100 : recent;

  let peak = history[0].nav;
  let maxDrawdown = 0;
  history.forEach((point) => {
    if (point.nav > peak) peak = point.nav;
    const dd = (point.nav / peak - 1) * 100;
    if (dd < maxDrawdown) maxDrawdown = dd;
  });

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const volatility = Math.sqrt(variance) * 100;

  return {
    cumulative,
    recent,
    oneYear,
    maxDrawdown,
    volatility
  };
}

export function trendState(metrics: FundMetrics | null): TrendState {
  if (!metrics) return { label: '数据不足', cls: 'flat' };
  if (metrics.recent > 2 && metrics.maxDrawdown > -10) return { label: '偏强', cls: 'strong' };
  if (metrics.recent < -2 && metrics.maxDrawdown < -8) return { label: '偏弱', cls: 'weak' };
  return { label: '震荡', cls: 'flat' };
}

export function computeCostUnit(amount: any, profit: any, latestNav: number | null) {
  const amountValue = toNumber(amount);
  const profitValue = toNumber(profit);
  const navValue = toNumber(latestNav);
  if (!amountValue || !navValue) return null;
  const costTotal = amountValue - (profitValue || 0);
  const units = amountValue / navValue;
  if (!units) return null;
  return costTotal / units;
}

export function computeHoldingView(holding: Holding, data: FundData | undefined | null) {
  const latestNav = data ? data.latestNav : null;
  const method = holding.method === 'shares' ? 'shares' : 'amount';
  if (method === 'shares') {
    const shares = toNumber(holding.shares);
    const costPrice = toNumber(holding.costPrice);
    const amount = shares && latestNav ? shares * latestNav : null;
    const profit = shares && costPrice !== null && latestNav ? (latestNav - costPrice) * shares : null;
    return {
      method,
      amount,
      profit,
      costUnit: costPrice
    };
  }
  const amountValue = toNumber(holding.amount);
  const profitValue = toNumber(holding.profit);
  const shares = toNumber(holding.shares);
  const costPrice = toNumber(holding.costPrice);

  let costBasis: number | null = null;
  if (shares !== null && costPrice !== null) {
    costBasis = shares * costPrice;
  } else if (amountValue !== null && profitValue !== null) {
    costBasis = amountValue - profitValue;
  }

  if (shares !== null && latestNav !== null) {
    const amount = Number((shares * latestNav).toFixed(2));
    const profit = costBasis !== null ? Number((amount - costBasis).toFixed(2)) : profitValue;
    const costUnit = costBasis !== null && shares ? costBasis / shares : computeCostUnit(amount, profit, latestNav);
    return {
      method,
      amount,
      profit,
      costUnit
    };
  }

  const costUnit = latestNav ? computeCostUnit(amountValue, profitValue, latestNav) : null;
  return {
    method,
    amount: amountValue,
    profit: profitValue,
    costUnit
  };
}
