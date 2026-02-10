'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChartRange,
  FundData,
  FundHistoryTableData,
  FundOperation,
  FundPositionData,
  FundPerformance,
  Holding,
  SearchItem,
  TradeTiming
} from '../../lib/types';
import { classByValue, containsCjk, formatMoney, formatPct, normalizeCode, toNumber } from '../../lib/utils';
import { computeCostUnit, computeHoldingView, computeMetrics } from '../../lib/metrics';
import FundCard from './FundCard';
import FundModal from './FundModal';

const STORAGE_KEYS = {
  holdings: 'steadyfund_holdings',
  watchlist: 'steadyfund_watchlist',
  operations: 'steadyfund_operations'
};

const LEGACY_KEY = 'steadyfund_portfolio';
const DEFAULT_WATCHLIST = ['161725', '001632', '005963'];

const CN_TIMEZONE = 'Asia/Shanghai';
const cnFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CN_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function todayCn() {
  const parts = cnFormatter.formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value || '';
  const month = parts.find((p) => p.type === 'month')?.value || '';
  const day = parts.find((p) => p.type === 'day')?.value || '';
  if (!year || !month || !day) return '';
  return `${year}-${month}-${day}`;
}

function isQdiiFund(name?: string | null) {
  if (!name) return false;
  return /QDII|海外|美股|全球|国际/i.test(name);
}

function computeApplyAt(date: string, timing: TradeTiming, isQdii: boolean) {
  const baseDate = date || todayCn();
  if (!baseDate) return Date.now();
  const base = new Date(`${baseDate}T15:00:00`);
  if (Number.isNaN(base.getTime())) return Date.now();
  const delay = timing === 'before' ? 1 : 2;
  const extra = isQdii ? 1 : 0;
  base.setDate(base.getDate() + delay + extra);
  return base.getTime();
}

function createOperationId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export default function AppShell() {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [operations, setOperations] = useState<FundOperation[]>([]);
  const [fundCache, setFundCache] = useState<Record<string, FundData>>({});
  const [loading, setLoading] = useState(false);
  const [showRate, setShowRate] = useState(false);
  const [positionCache, setPositionCache] = useState<Record<string, FundPositionData | null>>({});
  const [historyTableCache, setHistoryTableCache] = useState<Record<string, FundHistoryTableData | null>>({});
  const [performanceCache, setPerformanceCache] = useState<Record<string, FundPerformance | null>>({});
  const [extrasLoading, setExtrasLoading] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [performancePeriod, setPerformancePeriod] = useState('1y');

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchItem[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);

  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<'holding' | 'watchlist' | null>(null);
  const [holdingMethod, setHoldingMethod] = useState<'amount' | 'shares'>('amount');
  const [chartRange, setChartRange] = useState<ChartRange>('1y');

  const [form, setForm] = useState({
    amount: '',
    profit: '',
    shares: '',
    costPrice: '',
    firstBuy: ''
  });

  const searchTimerRef = useRef<number | null>(null);
  const searchBoxRef = useRef<HTMLDivElement | null>(null);
  const initializedRef = useRef(false);
  const suppressAutoSaveRef = useRef(false);

  const selectedData = selectedCode ? fundCache[selectedCode] : null;
  const selectedHolding = selectedCode ? holdings.find((item) => item.code === selectedCode) || null : null;
  const inWatchlist = selectedCode ? watchlist.includes(selectedCode) : false;
  const selectedPositions = selectedCode ? positionCache[selectedCode] || null : null;
  const historyKey = selectedCode ? `${selectedCode}_${historyPage}` : '';
  const selectedHistoryTable = selectedCode ? historyTableCache[historyKey] || null : null;
  const performanceKey = selectedCode ? `${selectedCode}:${performancePeriod}` : '';
  const selectedPerformance = selectedCode ? performanceCache[performanceKey] || null : null;
  const historyPages = selectedHistoryTable?.pages || 1;
  const selectedOperations = useMemo(
    () => (selectedCode ? operations.filter((op) => op.code === selectedCode) : []),
    [operations, selectedCode]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let parsedHoldings: Holding[] = [];
    let parsedWatchlist: string[] = [];
    let parsedOperations: FundOperation[] = [];
    const hasHoldingsKey = localStorage.getItem(STORAGE_KEYS.holdings) !== null;
    const hasWatchlistKey = localStorage.getItem(STORAGE_KEYS.watchlist) !== null;

    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.holdings) || '[]');
      if (Array.isArray(raw)) {
        parsedHoldings = raw
          .map((item: any) => {
            const method = item.method || (item.shares || item.costPrice ? 'shares' : 'amount');
            return {
              code: normalizeCode(item.code),
              method,
              amount: toNumber(item.amount),
              profit: toNumber(item.profit),
              shares: toNumber(item.shares),
              costPrice: toNumber(item.costPrice),
              firstBuy: item.firstBuy || ''
            } as Holding;
          })
          .filter((item) => item.code);
      }
    } catch {
      parsedHoldings = [];
    }

    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.watchlist) || '[]');
      if (Array.isArray(raw)) {
        parsedWatchlist = raw.map((code: string) => normalizeCode(code)).filter(Boolean);
      }
    } catch {
      parsedWatchlist = [];
    }

    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.operations) || '[]');
      if (Array.isArray(raw)) {
        parsedOperations = raw.filter(Boolean);
      }
    } catch {
      parsedOperations = [];
    }

    if (!hasHoldingsKey && !hasWatchlistKey && !parsedHoldings.length && !parsedWatchlist.length) {
      try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
        if (Array.isArray(legacy)) {
          parsedWatchlist = legacy.map((item: any) => normalizeCode(item.code)).filter(Boolean);
        }
      } catch {
        parsedWatchlist = [];
      }
    }

    if (!hasHoldingsKey && !hasWatchlistKey && !parsedWatchlist.length) {
      parsedWatchlist = DEFAULT_WATCHLIST.slice();
    }

    setHoldings(parsedHoldings);
    setWatchlist(parsedWatchlist);
    setOperations(parsedOperations);
    initializedRef.current = true;
  }, []);

  useEffect(() => {
    if (!initializedRef.current) return;
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEYS.holdings, JSON.stringify(holdings));
    localStorage.setItem(STORAGE_KEYS.watchlist, JSON.stringify(watchlist));
    localStorage.setItem(STORAGE_KEYS.operations, JSON.stringify(operations));
  }, [holdings, watchlist, operations]);

  useEffect(() => {
    if (!initializedRef.current) return;
    refreshData();
  }, [holdings, watchlist]);

  useEffect(() => {
    function updateStatus() {
      const now = Date.now();
      setOperations((prev) => {
        let changed = false;
        const next = prev.map((op) => {
          if (op.status === 'pending' && now >= op.applyAt) {
            changed = true;
            return { ...op, status: 'confirmed' };
          }
          return op;
        });
        return changed ? next : prev;
      });
    }

    updateStatus();
    const timer = window.setInterval(updateStatus, 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (!searchBoxRef.current) return;
      if (searchBoxRef.current.contains(event.target as Node)) return;
      setSearchOpen(false);
    }

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        closeModal();
      }
    }

    if (selectedCode) {
      document.addEventListener('keydown', handleKey);
      return () => document.removeEventListener('keydown', handleKey);
    }
  }, [selectedCode]);

  async function fetchFundData(code: string): Promise<FundData | null> {
    const normalized = normalizeCode(code);
    if (!normalized) return null;

    const [summaryRes, historyRes] = await Promise.allSettled([
      fetch(`/api/fund/${normalized}`),
      fetch(`/api/fund/${normalized}/values?days=365`)
    ]);

    let summary: any = null;
    if (summaryRes.status === 'fulfilled' && summaryRes.value.ok) {
      summary = await summaryRes.value.json();
    }

    let historyData: any = null;
    if (historyRes.status === 'fulfilled' && historyRes.value.ok) {
      historyData = await historyRes.value.json();
    }

    const history = Array.isArray(historyData?.history) ? historyData.history : [];
    const metrics = computeMetrics(history);

    return {
      code: normalized,
      name: summary?.name || historyData?.name || normalized,
      history,
      metrics,
      latestNav: summary?.latestNav ?? null,
      latestDate: summary?.latestDate || '',
      estNav: summary?.estNav ?? null,
      estPct: summary?.estPct ?? null,
      updateTime: summary?.updateTime || '',
      feeRate: summary?.feeRate ?? null
    } as FundData;
  }

  async function refreshData() {
    const codes = Array.from(new Set([...holdings.map((h) => h.code), ...watchlist]));
    if (!codes.length) return;
    setLoading(true);

    const results = await Promise.all(codes.map((code) => fetchFundData(code)));
    setFundCache((prev) => {
      const next = { ...prev };
      results.forEach((data) => {
        if (!data) return;
        next[data.code] = data;
      });
      return next;
    });

    setLoading(false);
  }

  function deriveDailyPct(data?: FundData | null) {
    if (!data) return null;
    if (typeof data.estPct === 'number' && !Number.isNaN(data.estPct)) return data.estPct;
    const history = data.history;
    if (!Array.isArray(history) || history.length < 2) return null;
    const last = history[history.length - 1]?.nav ?? null;
    const prev = history[history.length - 2]?.nav ?? null;
    if (!last || !prev) return null;
    return ((last / prev) - 1) * 100;
  }

  function computeLatestUpdateTime(codes: string[]) {
    let updateTime = '';
    codes.forEach((code) => {
      const data = fundCache[code];
      if (data && data.updateTime && data.updateTime > updateTime) updateTime = data.updateTime;
    });
    return updateTime;
  }

  const holdingsSummary = useMemo(() => {
    let totalAsset = 0;
    let totalProfit = 0;
    let totalCost = 0;
    let assetCount = 0;
    let profitCount = 0;
    let dailyProfit = 0;
    let dailyAsset = 0;
    let updateTime = '';

    holdings.forEach((holding) => {
      const data = fundCache[holding.code];
      if (data && data.updateTime && data.updateTime > updateTime) updateTime = data.updateTime;
      const view = computeHoldingView(holding, data);
      if (view.amount !== null) {
        assetCount += 1;
        totalAsset += view.amount;
      }
      if (view.amount !== null && view.profit !== null) {
        profitCount += 1;
        totalProfit += view.profit;
        totalCost += view.amount - view.profit;
      }
      const dailyPct = deriveDailyPct(data);
      if (view.amount !== null && dailyPct !== null) {
        dailyProfit += (view.amount * dailyPct) / 100;
        dailyAsset += view.amount;
      }
    });

    const totalReturnRate = profitCount && totalCost ? (totalProfit / totalCost) * 100 : null;
    const dailyReturnRate = dailyAsset ? (dailyProfit / dailyAsset) * 100 : null;

    return {
      totalAsset: assetCount ? totalAsset : null,
      totalProfit: profitCount ? totalProfit : null,
      totalReturnRate,
      dailyProfit: dailyAsset ? dailyProfit : null,
      dailyReturnRate,
      updateTime
    };
  }, [holdings, fundCache]);

  const refreshTime = holdings.length ? holdingsSummary.updateTime || '-' : computeLatestUpdateTime(watchlist) || '-';

  const costUnitText = useMemo(() => {
    if (!selectedData) return '--';
    if (holdingMethod === 'shares') {
      const costPrice = toNumber(form.costPrice);
      return costPrice !== null ? costPrice.toFixed(4) : '--';
    }
    const costUnit = computeCostUnit(form.amount, form.profit, selectedData.latestNav);
    return costUnit !== null ? costUnit.toFixed(4) : '--';
  }, [form.amount, form.profit, form.costPrice, holdingMethod, selectedData]);

  function handleSearchInput(value: string) {
    setSearchQuery(value);
    if (!value.trim()) {
      setSearchResults([]);
      setSearchOpen(false);
      return;
    }
    setSearchOpen(true);
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(async () => {
      const res = await fetch(`/api/search?q=${encodeURIComponent(value.trim())}`);
      if (!res.ok) return;
      const list = await res.json();
      setSearchResults(Array.isArray(list) ? list.slice(0, 8) : []);
    }, 200);
  }

  async function handleSearchEnter() {
    const query = searchQuery.trim();
    if (!query) return;
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return;
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) {
      setSearchResults([]);
      return;
    }
    if (list.length === 1) {
      setSearchOpen(false);
      openModal(list[0].code);
      return;
    }
    setSearchResults(list);
    setSearchOpen(true);
  }

  function openModal(code: string, source: 'holding' | 'watchlist' | '' = '') {
    const normalized = normalizeCode(code);
    if (!normalized) return;

    const holding = holdings.find((item) => item.code === normalized) || null;
    const isInWatchlist = watchlist.includes(normalized);
    let resolvedSource = source;
    if (!resolvedSource) {
      if (holding && !isInWatchlist) resolvedSource = 'holding';
      else if (!holding && isInWatchlist) resolvedSource = 'watchlist';
      else if (holding && isInWatchlist) resolvedSource = 'holding';
    }

    setSelectedCode(normalized);
    setSelectedSource(resolvedSource || null);
    setHistoryPage(1);

    const latestNav = fundCache[normalized]?.latestNav ?? null;
    const defaultMethod = resolveDefaultMethod(holding, latestNav);
    setHoldingMethod(defaultMethod);

    setForm(buildFormFromHolding(holding, latestNav));

    ensureFundData(normalized);
  }

  async function ensureFundData(code: string) {
    const cached = fundCache[code];
    if (cached && cached.feeRate !== null && cached.feeRate !== undefined) return;
    const data = await fetchFundData(code);
    if (!data) return;
    setFundCache((prev) => ({ ...prev, [code]: { ...(prev[code] || {}), ...data } }));
  }

  async function refreshFeeRate(code: string) {
    const normalized = normalizeCode(code);
    if (!normalized) return;
    const res = await fetch(`/api/fund/${normalized}/fee`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data) return;
    setFundCache((prev) => ({
      ...prev,
      [normalized]: { ...(prev[normalized] || {}), feeRate: data.feeRate ?? null }
    }));
  }

  async function ensureFundExtras(code: string, page = historyPage) {
    const hasPositions = positionCache[code] !== undefined;
    const historyKey = `${code}_${page}`;
    const hasHistoryTable = historyTableCache[historyKey] !== undefined;
    if (hasPositions && hasHistoryTable) return;

    setExtrasLoading(true);
    const [positionsRes, historyRes] = await Promise.allSettled([
      fetch(`/api/fund/${code}/positions`),
      fetch(`/api/fund/${code}/history-table?page=${page}`)
    ]);

    if (positionsRes.status === 'fulfilled' && positionsRes.value.ok) {
      const data = await positionsRes.value.json();
      setPositionCache((prev) => ({ ...prev, [code]: data }));
    } else if (!hasPositions) {
      setPositionCache((prev) => ({ ...prev, [code]: null }));
    }

    if (historyRes.status === 'fulfilled' && historyRes.value.ok) {
      const data = await historyRes.value.json();
      setHistoryTableCache((prev) => ({ ...prev, [historyKey]: data }));
    } else if (!hasHistoryTable) {
      setHistoryTableCache((prev) => ({ ...prev, [historyKey]: null }));
    }

    setExtrasLoading(false);
  }

  async function ensureFundPerformance(code: string, period: string) {
    const key = `${code}:${period}`;
    if (performanceCache[key] !== undefined) return;
    try {
      const res = await fetch(`/api/fund/${code}/performance?period=${encodeURIComponent(period)}`);
      if (!res.ok) {
        setPerformanceCache((prev) => ({ ...prev, [key]: null }));
        return;
      }
      const data = await res.json();
      const performance = data && data.period ? data : data?.performance || null;
      setPerformanceCache((prev) => ({ ...prev, [key]: performance }));
    } catch {
      setPerformanceCache((prev) => ({ ...prev, [key]: null }));
    }
  }

  useEffect(() => {
    if (!selectedCode) return;
    ensureFundExtras(selectedCode, historyPage);
  }, [historyPage, selectedCode]);

  useEffect(() => {
    if (!selectedCode) return;
    ensureFundPerformance(selectedCode, performancePeriod);
  }, [selectedCode, performancePeriod]);

  function closeModal() {
    setSelectedCode(null);
    setSelectedSource(null);
  }

  function addHolding() {
    if (!selectedCode) return;
    const code = selectedCode;
    const latestNav = selectedData?.latestNav ?? null;
    const amount = toNumber(form.amount);
    const profit = toNumber(form.profit);
    const shares = toNumber(form.shares);
    const costPrice = toNumber(form.costPrice);
    const firstBuy = form.firstBuy || '';

    saveHolding({ code, method: holdingMethod, amount, profit, shares, costPrice, firstBuy }, latestNav, false);

    if (!watchlist.includes(code)) {
      const confirmAdd = window.confirm('已添加持仓，是否同步加入自选？');
      if (confirmAdd) {
        addToWatchlist(code, false);
      }
    }
  }

  function addToWatchlist(code: string, showHint = true) {
    const normalized = normalizeCode(code);
    if (!normalized) return;
    setWatchlist((prev) => {
      if (prev.includes(normalized)) return prev;
      return [...prev, normalized];
    });
  }

  function addWatch() {
    if (!selectedCode) return;
    addToWatchlist(selectedCode, true);
  }

  function removeFund() {
    if (!selectedCode) return;
    const code = selectedCode;
    const inHoldings = holdings.some((item) => item.code === code);
    const inWatch = watchlist.includes(code);

    if (selectedSource === 'holding') {
      setHoldings((prev) => prev.filter((item) => item.code !== code));
    } else if (selectedSource === 'watchlist') {
      setWatchlist((prev) => prev.filter((item) => item !== code));
    } else if (inHoldings && !inWatch) {
      setHoldings((prev) => prev.filter((item) => item.code !== code));
    } else if (!inHoldings && inWatch) {
      setWatchlist((prev) => prev.filter((item) => item !== code));
    } else if (inHoldings && inWatch) {
      setHoldings((prev) => prev.filter((item) => item.code !== code));
    }

    setFundCache((prev) => {
      const stillInHoldings = holdings.some((item) => item.code === code && item.code !== code);
      const stillInWatch = watchlist.includes(code) && !(selectedSource === 'watchlist');
      if (stillInHoldings || stillInWatch) return prev;
      const next = { ...prev };
      delete next[code];
      return next;
    });

    closeModal();
  }

  const removeLabel = selectedSource === 'holding' ? '移除持仓' : selectedSource === 'watchlist' ? '移除自选' : '移除基金';

  const isCjkQuery = containsCjk(searchQuery || '');

  function recordOperation(op: FundOperation) {
    setOperations((prev) => {
      const next = [op, ...prev];
      return next.length > 200 ? next.slice(0, 200) : next;
    });
  }

  function buildEditOperation(prev: Holding | null, next: Holding): FundOperation {
    const now = Date.now();
    return {
      id: createOperationId(),
      code: next.code,
      type: 'edit',
      status: 'confirmed',
      createdAt: now,
      applyAt: now,
      method: next.method,
      amount: next.amount,
      shares: next.shares,
      date: todayCn(),
      prev,
      next
    };
  }

  function buildTradeOperation(
    type: 'add' | 'reduce',
    prev: Holding | null,
    next: Holding | null,
    meta: {
      amount?: number | null;
      shares?: number | null;
      feeRate?: number | null;
      fee?: number | null;
      date?: string;
      timing: TradeTiming;
      isQdii: boolean;
      method: 'amount' | 'shares';
    }
  ): FundOperation {
    const now = Date.now();
    const date = meta.date || todayCn();
    const applyAt = computeApplyAt(date, meta.timing, meta.isQdii);
    return {
      id: createOperationId(),
      code: prev?.code || next?.code || '',
      type,
      status: now >= applyAt ? 'confirmed' : 'pending',
      createdAt: now,
      applyAt,
      method: meta.method,
      amount: meta.amount ?? null,
      shares: meta.shares ?? null,
      feeRate: meta.feeRate ?? null,
      fee: meta.fee ?? null,
      date,
      timing: meta.timing,
      isQdii: meta.isQdii,
      prev,
      next
    };
  }

  // 持仓更新改为手动触发，不自动保存

  function resolveDefaultMethod(holding: Holding | null, latestNav: number | null): 'amount' | 'shares' {
    if (!holding) return 'amount';
    if (holding.amount !== null || holding.profit !== null) return 'amount';
    if (holding.shares !== null || holding.costPrice !== null) {
      if (latestNav && holding.shares) return 'amount';
      return 'shares';
    }
    return 'amount';
  }

  function formatFixed(value: number | null, digits: number) {
    if (value === null || value === undefined || Number.isNaN(value)) return '';
    return value.toFixed(digits);
  }

  function buildFormFromHolding(holding: Holding | null, latestNav: number | null) {
    if (!holding) {
      return { amount: '', profit: '', shares: '', costPrice: '', firstBuy: '' };
    }

    const amount = holding.amount !== null ? holding.amount : null;
    const profit = holding.profit !== null ? holding.profit : null;
    const shares = holding.shares !== null ? holding.shares : null;
    const costPrice = holding.costPrice !== null ? holding.costPrice : null;

    const computedFromShares =
      latestNav && shares
        ? {
            amount: formatFixed(shares * latestNav, 2),
            profit: costPrice !== null ? formatFixed((latestNav - costPrice) * shares, 2) : ''
          }
        : { amount: '', profit: '' };

    const computedFromAmount =
      latestNav && amount
        ? {
            shares: formatFixed(amount / latestNav, 2),
            costPrice: formatFixed(computeCostUnit(amount, profit, latestNav) ?? NaN, 4)
          }
        : { shares: '', costPrice: '' };

    return {
      amount: amount !== null ? formatFixed(amount, 2) : computedFromShares.amount,
      profit: profit !== null ? formatFixed(profit, 2) : computedFromShares.profit,
      shares: shares !== null ? formatFixed(shares, 2) : computedFromAmount.shares,
      costPrice: costPrice !== null ? formatFixed(costPrice, 4) : computedFromAmount.costPrice,
      firstBuy: holding.firstBuy || ''
    };
  }

  function syncFormForMethod(
    method: 'amount' | 'shares',
    prev: { amount: string; profit: string; shares: string; costPrice: string; firstBuy: string },
    latestNav: number | null
  ) {
    if (!latestNav) return prev;

    if (method === 'amount') {
      const shares = toNumber(prev.shares);
      const costPrice = toNumber(prev.costPrice);
      if (!shares) return prev;
      const amount = shares * latestNav;
      const profit = costPrice !== null ? (latestNav - costPrice) * shares : toNumber(prev.profit);
      return {
        ...prev,
        amount: formatFixed(amount, 2),
        profit: profit !== null ? formatFixed(profit, 2) : prev.profit
      };
    }

    const amount = toNumber(prev.amount);
    if (!amount) return prev;
    const profit = toNumber(prev.profit);
    const shares = amount / latestNav;
    const costPrice = computeCostUnit(amount, profit, latestNav);
    return {
      ...prev,
      shares: formatFixed(shares, 2),
      costPrice: costPrice !== null ? formatFixed(costPrice, 4) : prev.costPrice
    };
  }

  function buildHoldingPayload(
    code: string,
    method: 'amount' | 'shares',
    values: { amount: number | null; profit: number | null; shares: number | null; costPrice: number | null; firstBuy: string },
    latestNav: number | null
  ): Holding {
    if (method === 'shares') {
      const amount = latestNav && values.shares ? Number((values.shares * latestNav).toFixed(2)) : null;
      const profit =
        latestNav && values.shares && values.costPrice !== null
          ? Number(((latestNav - values.costPrice) * values.shares).toFixed(2))
          : null;
      return {
        code,
        method: 'shares',
        shares: values.shares,
        costPrice: values.costPrice,
        firstBuy: values.firstBuy,
        amount,
        profit
      };
    }

    const shares = latestNav && values.amount ? Number((values.amount / latestNav).toFixed(2)) : null;
    const costPrice = latestNav ? computeCostUnit(values.amount, values.profit, latestNav) : null;
    return {
      code,
      method: 'amount',
      amount: values.amount,
      profit: values.profit,
      firstBuy: values.firstBuy,
      shares,
      costPrice
    };
  }

  function saveHolding(payload: Holding, latestNav: number | null, silent: boolean, operation?: FundOperation | null) {
    setHoldings((prev) => {
      const next = [...prev];
      const idx = next.findIndex((item) => item.code === payload.code);
      if (idx >= 0) {
        next[idx] = payload;
      } else {
        next.push(payload);
      }
      return next;
    });

    if (operation) {
      recordOperation(operation);
    }

    if (!silent && !watchlist.includes(payload.code)) {
      const confirmAdd = window.confirm('已添加持仓，是否同步加入自选？');
      if (confirmAdd) {
        addToWatchlist(payload.code, false);
      }
    }
  }

  function handleUpdateHolding() {
    if (!selectedCode) return;
    const latestNav = selectedData?.latestNav ?? null;
    const amount = toNumber(form.amount);
    const profit = toNumber(form.profit);
    const shares = toNumber(form.shares);
    const costPrice = toNumber(form.costPrice);
    const firstBuy = form.firstBuy || '';

    const ready =
      holdingMethod === 'amount'
        ? amount !== null && profit !== null && Boolean(firstBuy)
        : shares !== null && costPrice !== null && Boolean(firstBuy);
    if (!ready) return;

    const payload = buildHoldingPayload(
      selectedCode,
      holdingMethod,
      { amount, profit, shares, costPrice, firstBuy },
      latestNav
    );

    const existing = holdings.find((item) => item.code === selectedCode) || null;
    if (existing && isSameHolding(existing, payload)) return;

    const op = buildEditOperation(existing, payload);
    saveHolding(payload, latestNav, true, op);
  }

  function handleTrade(
    type: 'add' | 'reduce',
    values: {
      amount?: number | null;
      shares?: number | null;
      feeRate?: number | null;
      fee?: number | null;
      date?: string;
      timing: TradeTiming;
    }
  ) {
    if (!selectedCode) return;
    const code = selectedCode;
    const latestNav = selectedData?.latestNav ?? null;
    const prev = holdings.find((item) => item.code === code) || null;
    const method: 'amount' | 'shares' =
      prev?.method || (values.shares !== null && values.shares !== undefined ? 'shares' : 'amount');
    if (type === 'reduce' && !prev) return;
    const date = values.date || todayCn();
    const timing = values.timing || 'before';
    const isQdii = isQdiiFund(selectedData?.name);

    const baseAmount =
      toNumber(prev?.amount) ?? (prev?.shares && latestNav ? prev.shares * latestNav : 0) ?? 0;
    const baseProfit =
      toNumber(prev?.profit) ??
      (prev?.shares && prev?.costPrice !== null && prev?.costPrice !== undefined && latestNav
        ? (latestNav - prev.costPrice) * prev.shares
        : 0) ??
      0;
    const baseShares =
      toNumber(prev?.shares) ?? (prev?.amount && latestNav ? prev.amount / latestNav : 0) ?? 0;

    if (type === 'reduce' && method === 'shares' && baseShares <= 0) return;
    if (type === 'reduce' && method === 'amount' && baseAmount <= 0) return;

    const deltaAmount =
      values.amount !== null && values.amount !== undefined
        ? values.amount
        : values.shares !== null && values.shares !== undefined && latestNav
          ? values.shares * latestNav
          : 0;
    const deltaShares =
      values.shares !== null && values.shares !== undefined
        ? values.shares
        : values.amount !== null && values.amount !== undefined && latestNav
          ? values.amount / latestNav
          : 0;

    let nextHolding: Holding | null = null;

    if (method === 'shares') {
      const delta = deltaShares || 0;
      let nextShares = type === 'add' ? baseShares + delta : baseShares - delta;
      nextShares = Number(nextShares.toFixed(2));
      if (nextShares > 0) {
        const costPrice = prev?.costPrice ?? null;
        const firstBuy = prev?.firstBuy || date || '';
        nextHolding = buildHoldingPayload(
          code,
          'shares',
          { amount: null, profit: null, shares: nextShares, costPrice, firstBuy },
          latestNav
        );
      }
    } else {
      const delta = deltaAmount || 0;
      let nextAmount = type === 'add' ? baseAmount + delta : baseAmount - delta;
      nextAmount = Number(nextAmount.toFixed(2));
      if (nextAmount > 0) {
        let nextProfit = baseProfit;
        if (type === 'reduce' && baseAmount > 0) {
          nextProfit = baseProfit * (nextAmount / baseAmount);
        }
        const firstBuy = prev?.firstBuy || date || '';
        nextHolding = buildHoldingPayload(
          code,
          'amount',
          { amount: nextAmount, profit: nextProfit, shares: null, costPrice: null, firstBuy },
          latestNav
        );
      }
    }

    const op = buildTradeOperation(type, prev, nextHolding, {
      amount: values.amount ?? null,
      shares: values.shares ?? null,
      feeRate: values.feeRate ?? null,
      fee: values.fee ?? null,
      date,
      timing,
      isQdii,
      method
    });

    suppressAutoSaveRef.current = true;
    if (nextHolding) {
      saveHolding(nextHolding, latestNav, true, op);
    } else {
      setHoldings((prevHoldings) => prevHoldings.filter((item) => item.code !== code));
      recordOperation(op);
    }

    setForm(buildFormFromHolding(nextHolding, latestNav));
    if (nextHolding) {
      setHoldingMethod(nextHolding.method);
    }
  }

  function handleTradeAdd(values: { amount: string; feeRate: string; date: string; timing: TradeTiming }) {
    const amount = toNumber(values.amount);
    if (amount === null || amount <= 0) return;
    handleTrade('add', {
      amount,
      feeRate: toNumber(values.feeRate),
      date: values.date,
      timing: values.timing
    });
  }

  function handleTradeReduce(values: { shares: string; fee: string; date: string; timing: TradeTiming }) {
    const shares = toNumber(values.shares);
    if (shares === null || shares <= 0) return;
    const latestNav = selectedData?.latestNav ?? null;
    const amount = latestNav ? Number((shares * latestNav).toFixed(2)) : null;
    handleTrade('reduce', {
      shares,
      amount,
      fee: toNumber(values.fee),
      date: values.date,
      timing: values.timing
    });
  }

  function handleUndoOperation(operationId: string) {
    const op = operations.find((item) => item.id === operationId);
    if (!op) return;
    const code = op.code;
    const prevHolding = op.prev ?? null;
    const latestNav = selectedData?.latestNav ?? null;

    suppressAutoSaveRef.current = true;
    if (prevHolding) {
      saveHolding(prevHolding, latestNav, true);
      setHoldingMethod(prevHolding.method);
    } else {
      setHoldings((prevHoldings) => prevHoldings.filter((item) => item.code !== code));
    }
    setForm(buildFormFromHolding(prevHolding, latestNav));
    setOperations((prevList) => prevList.filter((item) => item.id !== operationId));
  }

  function isSameHolding(a: Holding, b: Holding) {
    return (
      a.code === b.code &&
      a.method === b.method &&
      a.amount === b.amount &&
      a.profit === b.profit &&
      a.shares === b.shares &&
      a.costPrice === b.costPrice &&
      (a.firstBuy || '') === (b.firstBuy || '')
    );
  }

  return (
    <div className="page">
      <header className="topbar reveal">
        <div className="brand">
          <div className="logo">稳</div>
          <div className="brand-title">
            <h1>稳养基</h1>
            <span>基金辅助决策 · 认知辅助 + 行为约束</span>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="search-box" id="search-box" ref={searchBoxRef}>
            <input
              id="search-input"
              placeholder="搜索基金代码/名称"
              autoComplete="off"
              value={searchQuery}
              onChange={(e) => handleSearchInput(e.target.value)}
              onFocus={() => searchQuery && setSearchOpen(true)}
              onClick={() => searchQuery && setSearchOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearchEnter();
              }}
            />
            <div
              className="search-results"
              id="search-results"
              style={{ display: searchOpen && searchResults.length ? 'block' : 'none' }}
            >
              {searchResults.map((item) => {
                const displayName = item.name || '未知名称';
                const metaParts = isCjkQuery ? item.type || '' : item.type || '';
                return (
                  <div
                    key={`${item.code}-${item.name}`}
                    className="search-item"
                    data-code={item.code}
                    onClick={() => {
                      setSearchOpen(false);
                      openModal(item.code, '');
                    }}
                  >
                    <strong>{displayName}</strong>
                    <div className="search-meta">
                      {metaParts ? <small>{metaParts}</small> : <span />}
                      <span className="search-code">{item.code}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="pill">
            刷新时间 <strong id="refresh-time">{refreshTime}</strong>
          </div>
          {loading && (
            <div className="loading-indicator" id="loading-indicator">
              <span className="dot"></span> 数据拉取中
            </div>
          )}
          <button className="btn secondary" id="refresh-btn" onClick={refreshData}>
            刷新数据
          </button>
        </div>
      </header>

      <section className="hero reveal">
        <button
          className="hero-toggle"
          type="button"
          aria-label="切换收益显示"
          aria-pressed={showRate}
          title="切换收益显示"
          onClick={() => setShowRate((prev) => !prev)}
        >
          ⇄
        </button>
        <div className="hero-grid">
          <div>
            <h2>账户资产</h2>
          </div>
          <div className="hero-asset">
            <div className="hero-asset-grid">
              <div className="stat">
                <span>持仓总资产</span>
                <strong id="hero-asset">{holdingsSummary.totalAsset === null ? '-' : formatMoney(holdingsSummary.totalAsset)}</strong>
              </div>
              <div className="stat">
                <span>{showRate ? '收益率' : '持有收益'}</span>
                <strong
                  id="hero-return-rate"
                  className={classByValue(showRate ? holdingsSummary.totalReturnRate : holdingsSummary.totalProfit)}
                >
                  {showRate
                    ? holdingsSummary.totalReturnRate === null
                      ? '-'
                      : formatPct(holdingsSummary.totalReturnRate)
                    : holdingsSummary.totalProfit === null
                      ? '-'
                      : formatMoney(holdingsSummary.totalProfit)}
                </strong>
              </div>
              <div className="stat">
                <span>{showRate ? '当日收益率' : '当日收益'}</span>
                <strong
                  id="hero-daily-rate"
                  className={classByValue(showRate ? holdingsSummary.dailyReturnRate : holdingsSummary.dailyProfit)}
                >
                  {showRate
                    ? holdingsSummary.dailyReturnRate === null
                      ? '-'
                      : formatPct(holdingsSummary.dailyReturnRate)
                    : holdingsSummary.dailyProfit === null
                      ? '-'
                      : formatMoney(holdingsSummary.dailyProfit)}
                </strong>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section reveal">
        <h3>持仓基金</h3>
        <div className="subtitle">点击任意基金进入单基金视角。</div>
        <div className="fund-grid" id="fund-grid">
          {!holdings.length && <div className="empty-state">还没有持仓基金，请从顶部搜索添加。</div>}
          {holdings.map((holding) => (
            <FundCard
              key={holding.code}
              variant="holding"
              code={holding.code}
              data={fundCache[holding.code]}
              holding={holding}
              onOpen={() => openModal(holding.code, 'holding')}
            />
          ))}
        </div>
      </section>

      <section className="section reveal">
        <h3>自选基金</h3>
        <div className="subtitle">用于重点关注的基金（可包含持仓）。</div>
        <div className="fund-grid" id="watchlist-grid">
          {!watchlist.length && <div className="empty-state">暂无关注基金，请从顶部搜索添加。</div>}
          {watchlist.map((code) => (
            <FundCard
              key={code}
              variant="watchlist"
              code={code}
              data={fundCache[code]}
              isHolding={holdings.some((item) => item.code === code)}
              onOpen={() => openModal(code, 'watchlist')}
            />
          ))}
        </div>
      </section>

      <FundModal
        open={Boolean(selectedCode)}
        onClose={closeModal}
        data={selectedData}
        holding={selectedHolding}
        inWatchlist={inWatchlist}
        performance={selectedPerformance}
        performancePeriod={performancePeriod}
        positions={selectedPositions}
        historyTable={selectedHistoryTable}
        extrasLoading={extrasLoading}
        historyPage={historyPage}
        historyPages={historyPages}
        onHistoryPageChange={(page) => setHistoryPage(page)}
        operations={selectedOperations}
        holdingMethod={holdingMethod}
        onMethodChange={(method) => {
          setHoldingMethod(method);
          setForm((prev) => syncFormForMethod(method, prev, selectedData?.latestNav ?? null));
        }}
        form={form}
        costUnitText={costUnitText}
        onFormChange={(key, value) => setForm((prev) => ({ ...prev, [key]: value }))}
        onAddWatch={addWatch}
        onRemove={removeFund}
        removeLabel={removeLabel}
        onUpdateHolding={handleUpdateHolding}
        onEnsureFeeRate={() => {
          if (selectedCode) refreshFeeRate(selectedCode);
        }}
        onTradeAdd={handleTradeAdd}
        onTradeReduce={handleTradeReduce}
        onUndoOperation={handleUndoOperation}
        chartRange={chartRange}
        onChartRangeChange={setChartRange}
        onPerformancePeriodChange={setPerformancePeriod}
      />

      <div className="footnote">数据来源：东方财富。仅供参考，不构成投资建议。</div>
    </div>
  );
}
