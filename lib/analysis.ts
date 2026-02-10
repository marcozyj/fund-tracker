import type { FundHistoryPoint } from './types';

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

export function computeMovingAverage(history: FundHistoryPoint[], window: number) {
  if (history.length < window) return null;
  const slice = history.slice(-window).map((p) => p.nav);
  return mean(slice);
}

export function computeMomentum(history: FundHistoryPoint[], window: number) {
  if (history.length < window + 1) return null;
  const last = history[history.length - 1].nav;
  const prev = history[history.length - 1 - window].nav;
  if (!prev) return null;
  return ((last - prev) / prev) * 100;
}

export function analyzeFund(history: FundHistoryPoint[]) {
  if (!history.length) return null;
  const short = computeMovingAverage(history, 5);
  const long = computeMovingAverage(history, 20);
  const momentum = computeMomentum(history, 20);

  let maSignal: 'buy' | 'sell' | 'hold' = 'hold';
  if (short !== null && long !== null) {
    if (short > long) maSignal = 'buy';
    if (short < long) maSignal = 'sell';
  }

  let momentumSignal: 'buy' | 'sell' | 'hold' = 'hold';
  if (momentum !== null) {
    if (momentum > 1.5) momentumSignal = 'buy';
    if (momentum < -1.5) momentumSignal = 'sell';
  }

  const last = history[history.length - 1];

  return {
    date: last.date,
    signals: [
      {
        name: 'Moving Average',
        signal: maSignal,
        short,
        long
      },
      {
        name: 'Momentum',
        signal: momentumSignal,
        change: momentum
      }
    ]
  };
}

export function backtestMovingAverage(history: FundHistoryPoint[], shortWindow = 5, longWindow = 20, initialCapital = 10000) {
  if (history.length < longWindow + 2) return null;

  let capital = initialCapital;
  let shares = 0;
  const trades: { date: string; action: string; price: number; shares: number; capital: number }[] = [];

  for (let i = longWindow; i < history.length; i += 1) {
    const slice = history.slice(0, i + 1);
    const short = computeMovingAverage(slice, shortWindow);
    const long = computeMovingAverage(slice, longWindow);
    if (short === null || long === null) continue;
    const price = history[i].nav;

    if (short > long && capital > 0) {
      shares = capital / price;
      capital = 0;
      trades.push({ date: history[i].date, action: 'buy', price, shares, capital });
    }

    if (short < long && shares > 0) {
      capital = shares * price;
      trades.push({ date: history[i].date, action: 'sell', price, shares, capital });
      shares = 0;
    }
  }

  const lastPrice = history[history.length - 1].nav;
  const finalValue = capital > 0 ? capital : shares * lastPrice;
  const totalReturn = ((finalValue - initialCapital) / initialCapital) * 100;

  return {
    initial_capital: initialCapital,
    final_value: Number(finalValue.toFixed(2)),
    total_return: Number(totalReturn.toFixed(2)),
    trades
  };
}
