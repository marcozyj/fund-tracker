'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEventHandler } from 'react';
import type {
  ChartRange,
  BatchTradeInput,
  FundData,
  FundHistoryTableData,
  FundOperation,
  FundPositionData,
  FundPerformance,
  FundHistoryPoint,
  Holding,
  SearchItem,
  TradeTiming
} from '../../lib/types';
import {
  getFundFeeRateClient,
  getFundHistoryClient,
  getFundHistoryTableClient,
  getFundPerformanceClient,
  getFundPositionsClient,
  getFundSummaryClient,
  searchFundsClient
} from '../../lib/client-fund';
import { classByValue, containsCjk, formatMoney, formatMoneyWithSymbol, formatPct, normalizeCode, toNumber } from '../../lib/utils';
import { computeCostUnit, computeHoldingView, computeMetrics, resolveDailyPct } from '../../lib/metrics';
import { resolveFundByFuzzy } from '../../lib/fund-fuzzy';
import FundCard from './FundCard';
import FundModal from './FundModal';

const STORAGE_KEYS = {
  holdings: 'steadyfund_holdings',
  watchlist: 'steadyfund_watchlist',
  operations: 'steadyfund_operations'
};

const LEGACY_KEY = 'steadyfund_portfolio';
const DEFAULT_WATCHLIST = ['161725', '001632', '005963'];
const USE_DIRECT_API = true;
const REFRESH_INTERVAL_KEY = 'fund-tracker-refresh-interval';
const REFRESH_INTERVALS = [
  { label: '5秒', value: 5000 },
  { label: '1分钟', value: 60000 },
  { label: '10分钟', value: 600000 }
];
const DEFAULT_REFRESH_INTERVAL = 60000;

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

function normalizeHistoryDate(value: string) {
  if (!value) return '';
  return value.trim().slice(0, 10);
}

function findNavInHistoryStrict(
  date: string,
  timing: TradeTiming,
  history: FundHistoryPoint[] | null | undefined
) {
  if (!date || !history || history.length === 0) return null;
  const target = normalizeHistoryDate(date);
  const sorted = [...history]
    .map((item) => ({ ...item, date: normalizeHistoryDate(item.date) }))
    .filter((item) => item.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) return null;
  if (timing === 'before') {
    const exact = sorted.find((item) => item.date === target);
    return exact ? exact.nav : null;
  }
  const exactIndex = sorted.findIndex((item) => item.date === target);
  if (exactIndex >= 0) {
    if (exactIndex + 1 < sorted.length) return sorted[exactIndex + 1].nav;
    return null;
  }
  const next = sorted.find((item) => item.date > target);
  return next ? next.nav : null;
}

function extractHistoryFromTable(content: string) {
  if (!content) return [];
  if (typeof DOMParser === 'undefined') return [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(content, 'text/html');
  const rows = Array.from(doc.querySelectorAll('tr'));
  const list: FundHistoryPoint[] = [];
  rows.forEach((row) => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 2) return;
    const date = cells[0]?.textContent?.trim() || '';
    const navText = cells[1]?.textContent?.trim() || '';
    const nav = Number(navText.replace(/,/g, ''));
    if (!date || !Number.isFinite(nav)) return;
    list.push({ date: normalizeHistoryDate(date), nav });
  });
  return list;
}

function findNavFromHistoryTable(
  date: string,
  timing: TradeTiming,
  historyCache: Record<string, FundHistoryTableData | null>,
  code: string
) {
  const entries = Object.entries(historyCache).filter(([key, value]) => key.startsWith(`${code}_`) && value?.content);
  if (!entries.length) return null;
  const combined: FundHistoryPoint[] = [];
  entries.forEach(([, value]) => {
    if (value?.content) {
      combined.push(...extractHistoryFromTable(value.content));
    }
  });
  return findNavInHistoryStrict(date, timing, combined);
}

type TreemapItem = {
  code: string;
  holding: Holding;
  weight: number;
  pct: number | null;
};

type TreemapTile = {
  x: number;
  y: number;
  w: number;
  h: number;
  item: TreemapItem;
};

function treemapWorst(row: Array<{ area: number }>, w: number) {
  if (!row.length) return Infinity;
  const sum = row.reduce((acc, item) => acc + item.area, 0);
  const max = Math.max(...row.map((item) => item.area));
  const min = Math.min(...row.map((item) => item.area));
  if (min <= 0) return Infinity;
  const w2 = w * w;
  return Math.max((w2 * max) / (sum * sum), (sum * sum) / (w2 * min));
}

function treemapLayoutRow(
  row: Array<{ area: number; item: TreemapItem }>,
  rect: { x: number; y: number; w: number; h: number }
) {
  const sum = row.reduce((acc, item) => acc + item.area, 0);
  const tiles: TreemapTile[] = [];
  if (rect.w >= rect.h) {
    const rowHeight = sum / rect.w;
    let x = rect.x;
    row.forEach((entry) => {
      const width = entry.area / rowHeight;
      tiles.push({ x, y: rect.y, w: width, h: rowHeight, item: entry.item });
      x += width;
    });
    return {
      tiles,
      rect: { x: rect.x, y: rect.y + rowHeight, w: rect.w, h: rect.h - rowHeight }
    };
  }
  const rowWidth = sum / rect.h;
  let y = rect.y;
  row.forEach((entry) => {
    const height = entry.area / rowWidth;
    tiles.push({ x: rect.x, y, w: rowWidth, h: height, item: entry.item });
    y += height;
  });
  return {
    tiles,
    rect: { x: rect.x + rowWidth, y: rect.y, w: rect.w - rowWidth, h: rect.h }
  };
}

function buildTreemap(items: TreemapItem[], width: number, height: number) {
  if (!items.length || width <= 0 || height <= 0) return [];
  const sorted = [...items].sort((a, b) => b.weight - a.weight);
  const rowCount = sorted.length <= 6 ? 2 : 3;
  const rowHeight = height / rowCount;
  const rows = Array.from({ length: rowCount }, () => ({ items: [] as TreemapItem[], weight: 0 }));

  sorted.forEach((item) => {
    let target = rows[0];
    rows.forEach((row) => {
      if (row.weight < target.weight) target = row;
    });
    target.items.push(item);
    target.weight += item.weight;
  });

  const tiles: TreemapTile[] = [];
  rows.forEach((row, rowIndex) => {
    const totalWeight = row.weight > 0 ? row.weight : row.items.length;
    let x = 0;
    row.items.forEach((item, idx) => {
      const ratio = totalWeight > 0 ? (item.weight / totalWeight) : 1 / row.items.length;
      const w = idx === row.items.length - 1 ? width - x : width * ratio;
      tiles.push({
        x,
        y: rowIndex * rowHeight,
        w,
        h: rowHeight,
        item
      });
      x += w;
    });
  });

  return tiles;
}

function createOperationId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function ensureFundEntry(cache: Record<string, FundData>, code: string): FundData {
  return (
    cache[code] ?? {
      code,
      name: code,
      history: [],
      metrics: null,
      latestNav: null,
      latestDate: '',
      estNav: null,
      estPct: null,
      updateTime: '',
      feeRate: null
    }
  );
}

export default function AppShell() {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [operations, setOperations] = useState<FundOperation[]>([]);
  const [fundCache, setFundCache] = useState<Record<string, FundData>>({});
  const [loading, setLoading] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState<number>(DEFAULT_REFRESH_INTERVAL);
  const [showRate, setShowRate] = useState(false);
  const [positionCache, setPositionCache] = useState<Record<string, FundPositionData | null>>({});
  const [historyTableCache, setHistoryTableCache] = useState<Record<string, FundHistoryTableData | null>>({});
  const [performanceCache, setPerformanceCache] = useState<Record<string, FundPerformance | null>>({});
  const [extrasLoading, setExtrasLoading] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [performancePeriod, setPerformancePeriod] = useState('1y');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [holdingViewMode, setHoldingViewMode] = useState<'card' | 'table'>('card');
  const [treemapSize, setTreemapSize] = useState({ width: 0, height: 0 });

  const holdingAmountRank = useMemo(() => {
    if (!holdings.length) return new Map<string, number>();
    const ranked = holdings
      .map((holding) => {
        const view = computeHoldingView(holding, fundCache[holding.code]);
        return { code: holding.code, amount: view.amount ?? 0 };
      })
      .sort((a, b) => b.amount - a.amount);
    const map = new Map<string, number>();
    ranked.forEach((item, index) => {
      map.set(item.code, index);
    });
    return map;
  }, [holdings, fundCache]);

  const sortedHoldings = useMemo(() => {
    if (!holdings.length) return [];
    return [...holdings].sort((a, b) => {
      const rankA = holdingAmountRank.get(a.code) ?? Number.MAX_SAFE_INTEGER;
      const rankB = holdingAmountRank.get(b.code) ?? Number.MAX_SAFE_INTEGER;
      if (rankA === rankB) return a.code.localeCompare(b.code);
      return rankA - rankB;
    });
  }, [holdings, holdingAmountRank]);

  const treemapTiles = useMemo(() => {
    if (!sortedHoldings.length || treemapSize.width <= 0 || treemapSize.height <= 0) return [];
    const items: TreemapItem[] = sortedHoldings.map((holding) => {
      const view = computeHoldingView(holding, fundCache[holding.code]);
      const amount = view.amount ?? 0;
      const weight = Number.isFinite(amount) && amount > 0 ? amount : 1;
      const pct = resolveDailyPct(fundCache[holding.code]);
      return {
        code: holding.code,
        holding,
        weight,
        pct: pct === null || pct === undefined ? null : pct
      };
    });
    return buildTreemap(items, treemapSize.width, treemapSize.height);
  }, [sortedHoldings, fundCache, treemapSize]);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchItem[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);

  const [scanPickOpen, setScanPickOpen] = useState(false);
  const [scanConfirmOpen, setScanConfirmOpen] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isScanImporting, setIsScanImporting] = useState(false);
  const [scanDragging, setScanDragging] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanProgress, setScanProgress] = useState({ stage: 'ocr' as 'ocr' | 'verify', current: 0, total: 0 });
  const [scanImportProgress, setScanImportProgress] = useState({ current: 0, total: 0, success: 0, failed: 0 });
  const [scannedFunds, setScannedFunds] = useState<
    Array<{ code: string; name: string; status: 'ok' | 'added' | 'invalid'; amount?: number; profit?: number }>
  >([]);
  const [selectedScannedCodes, setSelectedScannedCodes] = useState<Set<string>>(new Set());

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
  const recalculatingRef = useRef(false);
  const feeNormalizedRef = useRef(false);
  const historyCacheRef = useRef<Record<string, FundHistoryTableData | null>>({});
  const navResolveCacheRef = useRef<Map<string, number | null>>(new Map());
  const navPendingRef = useRef<Map<string, Promise<number | null>>>(new Map());
  const opAmountSyncKeyRef = useRef<string>('');
  const holdingSyncKeyRef = useRef<Map<string, string>>(new Map());
  const extrasPendingRef = useRef<Set<string>>(new Set());
  const refreshPendingRef = useRef(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const scanInputRef = useRef<HTMLInputElement | null>(null);
  const abortScanRef = useRef(false);
  const treemapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    historyCacheRef.current = historyTableCache;
  }, [historyTableCache]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const node = treemapRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (frame) cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setTreemapSize((prev) => {
          if (Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1) return prev;
          return { width, height };
        });
      });
    });
    observer.observe(node);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(REFRESH_INTERVAL_KEY);
    if (!saved) return;
    const value = Number(saved);
    if (Number.isFinite(value) && REFRESH_INTERVALS.some((item) => item.value === value)) {
      setRefreshInterval(value);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(REFRESH_INTERVAL_KEY, String(refreshInterval));
  }, [refreshInterval]);

  const selectedData = selectedCode ? fundCache[selectedCode] : null;
  const selectedHolding = selectedCode ? holdings.find((item) => item.code === selectedCode) || null : null;
  const inWatchlist = selectedCode ? watchlist.includes(selectedCode) : false;
  const selectedPositions = selectedCode ? positionCache[selectedCode] || null : null;
  const historyKey = selectedCode ? `${selectedCode}_${historyPage}` : '';
  const selectedHistoryTable = selectedCode ? historyTableCache[historyKey] || null : null;
  const performanceKey = selectedCode ? `${selectedCode}:${performancePeriod}` : '';
  const selectedPerformance = selectedCode ? performanceCache[performanceKey] || null : null;
  const historyPages = selectedHistoryTable?.pages || 1;
  const fundCandidates = useMemo(() => {
    const codes = new Set<string>();
    holdings.forEach((item) => codes.add(item.code));
    watchlist.forEach((code) => codes.add(code));
    return Array.from(codes).map((code) => ({
      code,
      name: fundCache[code]?.name || ''
    }));
  }, [holdings, watchlist, fundCache]);
  const selectedOperations = useMemo(() => {
    if (!selectedCode) return [];
    const list = operations.filter((op) => op.code === selectedCode);
    return list.sort((a, b) => {
      const dateA = a.date || '';
      const dateB = b.date || '';
      if (dateA && dateB && dateA !== dateB) {
        return dateB.localeCompare(dateA);
      }
      if (dateA && !dateB) return -1;
      if (!dateA && dateB) return 1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }, [operations, selectedCode, historyOpen]);

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
        parsedOperations = raw.filter(Boolean).map((op: FundOperation) => {
          if ((op.type === 'add' || op.type === 'reduce') && (op.fee === null || op.fee === undefined)) {
            return { ...op, fee: 0 };
          }
          return op;
        });
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
    if (!holdings.length) return;
    setHoldings((prev) => {
      let changed = false;
      const next = prev.map((holding) => {
        if (holding.method !== 'amount') return holding;
        if (holding.shares !== null && holding.shares !== undefined && holding.costPrice !== null && holding.costPrice !== undefined) {
          return holding;
        }
        const data = fundCache[holding.code];
        const latestNav = data?.latestNav ?? null;
        if (!latestNav) return holding;
        const amount = toNumber(holding.amount);
        if (amount === null) return holding;
        const profit = toNumber(holding.profit);
        const nextShares = holding.shares ?? Number((amount / latestNav).toFixed(2));
        const nextCostPrice =
          holding.costPrice ?? computeCostUnit(amount, profit, latestNav);
        if (nextShares === holding.shares && nextCostPrice === holding.costPrice) {
          return holding;
        }
        changed = true;
        return {
          ...holding,
          shares: nextShares,
          costPrice: nextCostPrice
        };
      });
      return changed ? next : prev;
    });
  }, [fundCache, holdings]);

  useEffect(() => {
    if (!initializedRef.current) return;
    if (feeNormalizedRef.current) return;
    const hasMissing = operations.some(
      (op) => (op.type === 'add' || op.type === 'reduce') && (op.fee === null || op.fee === undefined)
    );
    if (!hasMissing) {
      feeNormalizedRef.current = true;
      return;
    }
    feeNormalizedRef.current = true;
    setOperations((prev) =>
      prev.map((op) =>
        (op.type === 'add' || op.type === 'reduce') && (op.fee === null || op.fee === undefined)
          ? { ...op, fee: 0 }
          : op
      )
    );
  }, [operations]);

  useEffect(() => {
    if (!initializedRef.current) return;
    refreshData();
  }, [holdings, watchlist]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!holdings.length && !watchlist.length) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      refreshData();
    }, refreshInterval);
    return () => window.clearInterval(timer);
  }, [refreshInterval, holdings.length, watchlist.length]);

  useEffect(() => {
    function updateStatus() {
      const now = Date.now();
      setOperations((prev) => {
        let changed = false;
        const next = prev.map((op) => {
          if (op.status === 'pending' && now >= op.applyAt) {
            changed = true;
            return { ...op, status: 'confirmed' as FundOperation['status'] };
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

  const resolveNavForOp = useCallback(
    async (code: string, date: string, timing: TradeTiming) => {
      const normalizedDate = normalizeHistoryDate(date);
      if (!code || !normalizedDate) return null;
      const key = `${code}|${normalizedDate}|${timing}`;
      if (navResolveCacheRef.current.has(key)) {
        return navResolveCacheRef.current.get(key) ?? null;
      }
      const pending = navPendingRef.current.get(key);
      if (pending) return pending;

      const promise = (async () => {
        const fromCache = findNavFromHistoryTable(normalizedDate, timing, historyCacheRef.current, code);
        if (fromCache !== null) return fromCache;

        const fetchPage = async (page: number) => {
          let data: FundHistoryTableData | null = null;
          if (USE_DIRECT_API) {
            data = await getFundHistoryTableClient(code, page);
          } else {
            const res = await fetch(`/api/fund/${code}/history-table?page=${page}`);
            if (!res.ok) return null;
            data = await res.json();
          }
          if (!data) return null;
          setHistoryTableCache((prev) => {
            const next = { ...prev, [`${code}_${page}`]: data };
            historyCacheRef.current = next;
            return next;
          });
          return data as FundHistoryTableData;
        };

        const first = await fetchPage(1);
        if (!first) return null;
        let nav = findNavInHistoryStrict(normalizedDate, timing, extractHistoryFromTable(first.content || ''));
        if (nav !== null) return nav;
        const totalPages = Number(first.pages) || 1;
        for (let page = 2; page <= totalPages; page += 1) {
          const data = await fetchPage(page);
          if (!data) continue;
          nav = findNavInHistoryStrict(normalizedDate, timing, extractHistoryFromTable(data.content || ''));
          if (nav !== null) return nav;
        }
        return null;
      })();

      navPendingRef.current.set(key, promise);
      const resolved = await promise;
      navResolveCacheRef.current.set(key, resolved);
      navPendingRef.current.delete(key);
      return resolved;
    },
    []
  );

  function buildHoldingSyncKey(ops: FundOperation[], latestNav: number | null) {
    return ops
      .map((op) => `${op.id}:${op.type}:${op.date}:${op.timing}:${op.amount ?? ''}:${op.shares ?? ''}`)
      .join('|')
      .concat(`|nav:${latestNav ?? ''}`);
  }

  async function computeHoldingFromOperations(
    code: string,
    ops: FundOperation[],
    latestNav: number | null
  ): Promise<Holding | null> {
    const sorted = ops
      .slice()
      .sort((a, b) => {
        const dateA = a.date || '';
        const dateB = b.date || '';
        if (dateA && dateB && dateA !== dateB) return dateA.localeCompare(dateB);
        return (a.createdAt || 0) - (b.createdAt || 0);
      });

    let shares = 0;
    let cost = 0;
    let firstBuy = '';

    for (const op of sorted) {
      const date = op.date || '';
      const timing = op.timing || 'before';
      if (op.type === 'edit' && op.next) {
        if (op.next.method === 'shares' && op.next.shares !== null && op.next.shares !== undefined) {
          shares = Number(op.next.shares) || 0;
          if (op.next.costPrice !== null && op.next.costPrice !== undefined) {
            cost = shares * Number(op.next.costPrice);
          } else if (op.next.amount !== null && op.next.amount !== undefined && latestNav) {
            cost = Number(op.next.amount);
          }
        } else if (op.next.method === 'amount' && op.next.amount !== null && op.next.amount !== undefined) {
          const profit = Number(op.next.profit ?? 0) || 0;
          cost = Number(op.next.amount) - profit;
          const nav = await resolveNavForOp(code, date || todayCn(), timing);
          if (nav) {
            shares = Number((Number(op.next.amount) / nav).toFixed(2));
          } else if (latestNav) {
            shares = Number((Number(op.next.amount) / latestNav).toFixed(2));
          }
        }
        firstBuy = op.next.firstBuy || firstBuy || date;
        continue;
      }

      if (op.type === 'add') {
        let deltaShares = op.shares !== null && op.shares !== undefined ? Number(op.shares) : null;
        let deltaAmount = op.amount !== null && op.amount !== undefined ? Number(op.amount) : null;

        if (deltaShares === null && deltaAmount !== null) {
          const nav = await resolveNavForOp(code, date, timing);
          if (nav) {
            deltaShares = Number((deltaAmount / nav).toFixed(2));
          } else if (latestNav) {
            deltaShares = Number((deltaAmount / latestNav).toFixed(2));
          }
        }

        if (deltaShares !== null && deltaShares > 0) {
          shares += deltaShares;
          const fee = Number(op.fee ?? 0) || 0;
          if (deltaAmount === null && deltaShares && latestNav) {
            deltaAmount = Number((deltaShares * latestNav).toFixed(2));
          }
          cost += (deltaAmount ?? 0) + fee;
          if (!firstBuy) firstBuy = date;
        }
      }

      if (op.type === 'reduce') {
        let deltaShares = op.shares !== null && op.shares !== undefined ? Number(op.shares) : null;
        if (deltaShares === null && op.amount !== null && op.amount !== undefined) {
          const nav = await resolveNavForOp(code, date, timing);
          if (nav) {
            deltaShares = Number((Number(op.amount) / nav).toFixed(2));
          } else if (latestNav) {
            deltaShares = Number((Number(op.amount) / latestNav).toFixed(2));
          }
        }
        if (deltaShares !== null && deltaShares > 0 && shares > 0) {
          const prevShares = shares;
          shares = Math.max(0, Number((shares - deltaShares).toFixed(2)));
          if (prevShares > 0) {
            cost = cost * (shares / prevShares);
          }
        }
      }
    }

    if (shares > 0) {
      const costPrice = shares ? cost / shares : null;
      const amount = latestNav ? Number((shares * latestNav).toFixed(2)) : null;
      const profit = amount !== null ? Number((amount - cost).toFixed(2)) : null;
      return {
        code,
        method: 'shares',
        amount,
        profit,
        shares: Number(shares.toFixed(2)),
        costPrice: costPrice !== null ? Number(costPrice.toFixed(4)) : null,
        firstBuy
      };
    }

    return null;
  }

  function applyHoldingUpdate(nextHolding: Holding) {
    setHoldings((prev) => {
      const existing = prev.find((item) => item.code === nextHolding.code) || null;
      if (existing && isSameHolding(existing, nextHolding)) return prev;
      const next = prev.filter((item) => item.code !== nextHolding.code);
      next.push(nextHolding);
      return next;
    });
  }

  useEffect(() => {
    if (!selectedCode) return;
    if (!operations.length) return;
    if (!historyOpen) return;
    if (recalculatingRef.current) return;
    let cancelled = false;

    async function refreshOperationAmounts() {
      const code = selectedCode;
      const related = operations.filter((op) => op.code === code && op.date);
      if (!related.length) return;
      const key = related
        .map((op) => `${op.id}:${op.type}:${op.date}:${op.timing}:${op.amount ?? ''}:${op.shares ?? ''}`)
        .join('|');
      if (opAmountSyncKeyRef.current === key) return;
      opAmountSyncKeyRef.current = key;
      recalculatingRef.current = true;

      const nextById = new Map<string, FundOperation>();
      const navCache = new Map<string, number | null>();

      for (const op of related) {
        const key = `${op.date || ''}|${op.timing || 'before'}`;
        if (!navCache.has(key)) {
          const nav = await resolveNavForOp(code, op.date || '', op.timing || 'before');
          navCache.set(key, nav);
        }
        const nav = navCache.get(key) ?? null;
        if (nav === null) continue;

        const updates: Partial<FundOperation> = {};
        if (op.nav !== nav) {
          updates.nav = nav;
        }
        const hasShares = op.shares !== null && op.shares !== undefined;
        const hasAmount = op.amount !== null && op.amount !== undefined;

        if (op.type === 'reduce') {
          if (hasShares) {
            const expectedAmount = Number(((op.shares as number) * nav).toFixed(2));
            if (op.amount !== expectedAmount) {
              updates.amount = expectedAmount;
            }
          } else if (hasAmount) {
            const expectedShares = Number(((op.amount as number) / nav).toFixed(2));
            if (op.shares !== expectedShares) {
              updates.shares = expectedShares;
            }
          }
        } else if (op.type === 'add') {
          if (hasAmount && !hasShares) {
            const expectedShares = Number(((op.amount as number) / nav).toFixed(2));
            updates.shares = expectedShares;
          } else if (hasShares && !hasAmount) {
            const expectedAmount = Number(((op.shares as number) * nav).toFixed(2));
            updates.amount = expectedAmount;
          }
        }

        if (Object.keys(updates).length) {
          nextById.set(op.id, { ...op, ...updates });
        }
      }

      if (cancelled || nextById.size === 0) {
        recalculatingRef.current = false;
        return;
      }
      setOperations((prev) =>
        prev.map((op) => {
          const updated = nextById.get(op.id);
          return updated ? updated : op;
        })
      );
      recalculatingRef.current = false;
    }

    refreshOperationAmounts();
    return () => {
      cancelled = true;
      recalculatingRef.current = false;
    };
  }, [operations, selectedCode]);

  const selectedLatestNav = selectedCode ? fundCache[selectedCode]?.latestNav ?? null : null;

  useEffect(() => {
    if (!selectedCode) return;
    if (!operations.length) return;
    if (recalculatingRef.current) return;
    let cancelled = false;

    async function recomputeHoldingsFromOperations() {
      const code = selectedCode;
      const ops = operations.filter((op) => op.code === code && op.date);
      if (!ops.length) return;
      const latestNav = selectedLatestNav ?? null;
      const key = buildHoldingSyncKey(ops, latestNav);
      if (holdingSyncKeyRef.current.get(code) === key) return;
      holdingSyncKeyRef.current.set(code, key);
      recalculatingRef.current = true;
      try {
        const nextHolding = await computeHoldingFromOperations(code, ops, latestNav);
        if (cancelled) return;
        if (nextHolding) applyHoldingUpdate(nextHolding);
      } finally {
        recalculatingRef.current = false;
      }
    }

    recomputeHoldingsFromOperations();
    return () => {
      cancelled = true;
      recalculatingRef.current = false;
    };
  }, [operations, selectedCode, selectedLatestNav]);

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

    try {
      if (USE_DIRECT_API) {
        const [summaryRes, historyRes] = await Promise.allSettled([
          getFundSummaryClient(normalized),
          getFundHistoryClient(normalized, 365)
        ]);
        const summary = summaryRes.status === 'fulfilled' ? summaryRes.value : null;
        const historyData = historyRes.status === 'fulfilled' ? historyRes.value : null;
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
    } catch {
      return null;
    }
  }

  async function refreshData() {
    if (refreshPendingRef.current) return;
    const codes = Array.from(new Set([...holdings.map((h) => h.code), ...watchlist]));
    if (!codes.length) return;
    refreshPendingRef.current = true;
    setLoading(true);

    try {
      const results = await Promise.all(codes.map((code) => fetchFundData(code)));
      setFundCache((prev) => {
        const next = { ...prev };
        results.forEach((data) => {
          if (!data) return;
          next[data.code] = data;
        });
        return next;
      });

      if (operations.length && holdings.length) {
        const latestNavByCode = new Map<string, number | null>();
        results.forEach((data) => {
          if (!data) return;
          latestNavByCode.set(data.code, data.latestNav ?? null);
        });

        const updates = new Map<string, Holding>();
        for (const holding of holdings) {
          const code = holding.code;
          const ops = operations.filter((op) => op.code === code && op.date);
          if (!ops.length) continue;
          const latestNav = latestNavByCode.get(code) ?? fundCache[code]?.latestNav ?? null;
          const key = buildHoldingSyncKey(ops, latestNav);
          if (holdingSyncKeyRef.current.get(code) === key) continue;
          holdingSyncKeyRef.current.set(code, key);
          const nextHolding = await computeHoldingFromOperations(code, ops, latestNav);
          if (nextHolding) updates.set(code, nextHolding);
        }

        if (updates.size) {
          setHoldings((prev) => {
            let changed = false;
            const next = prev.map((item) => {
              const updated = updates.get(item.code);
              if (!updated) return item;
              if (isSameHolding(item, updated)) return item;
              changed = true;
              return updated;
            });
            return changed ? next : prev;
          });
        }
      }
    } finally {
      setLoading(false);
      refreshPendingRef.current = false;
    }
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
      const dailyPct = resolveDailyPct(data);
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
      try {
        let list: any = [];
        if (USE_DIRECT_API) {
          list = await searchFundsClient(value.trim(), 8);
        } else {
          const res = await fetch(`/api/search?q=${encodeURIComponent(value.trim())}`);
          if (!res.ok) return;
          list = await res.json();
        }
        setSearchResults(Array.isArray(list) ? list.slice(0, 8) : []);
      } catch {
        setSearchResults([]);
      }
    }, 200);
  }

  async function handleSearchEnter() {
    const query = searchQuery.trim();
    if (!query) return;
    let list: any = [];
    if (USE_DIRECT_API) {
      list = await searchFundsClient(query, 8);
    } else {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) return;
      list = await res.json();
    }
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

  const SCAN_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];


  const normalizeOcrText = (value: string) =>
    value.replace(/\s+/g, '').replace(/[·•()（）【】\[\]_-]/g, '').trim();

  const parseNumberTokens = (value: string) => {
    const matches = value.match(/[+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|[+-]?\d+(?:\.\d+)?/g) || [];
    return matches
      .map((item) => Number(item.replace(/,/g, '')))
      .filter((num) => Number.isFinite(num));
  };

  const normalizeGlmHolding = (raw: any) => {
    const name = normalizeOcrText(
      String(raw?.name ?? raw?.fund ?? raw?.title ?? raw?.fund_name ?? raw?.fundName ?? '')
    );
    const amountSource = String(
      raw?.amount_text ??
        raw?.amountText ??
        raw?.amount ??
        raw?.holding_amount ??
        raw?.holdingAmount ??
        raw?.amount_value ??
        raw?.amountValue ??
        raw?.value ??
        ''
    );
    const profitSource = String(
      raw?.profit_text ??
        raw?.profitText ??
        raw?.profit ??
        raw?.holding_profit ??
        raw?.holdingProfit ??
        raw?.profit_value ??
        raw?.profitValue ??
        raw?.holding_yield ??
        raw?.holdingIncome ??
        ''
    );
    const amountTokens = parseNumberTokens(amountSource);
    const amount = amountTokens.length
      ? amountTokens.reduce((max, val) => (Math.abs(val) > Math.abs(max) ? val : max), 0)
      : null;
    const profitTokens = parseNumberTokens(profitSource);
    const profit = profitTokens.length
      ? profitTokens.reduce((max, val) => (Math.abs(val) > Math.abs(max) ? val : max), 0)
      : null;
    return {
      name,
      amount: amount !== null ? Math.abs(amount) : null,
      profit,
      amountRaw: amountSource,
      profitRaw: profitSource
    };
  };

  const formatSignedMoney = (value: number | null) => {
    if (value === null || value === undefined || Number.isNaN(value)) return '--';
    const sign = value > 0 ? '+' : value < 0 ? '-' : '';
    return `${sign}${formatMoney(Math.abs(value))}`;
  };

  const OCR_NAME_ALIASES: Array<{ pattern: RegExp; code: string; name: string }> = [
    {
      pattern: /长城久嘉创新成长灵活配置混合C/i,
      code: '010052',
      name: '长城久嘉创新成长混合C'
    },
    {
      pattern: /招商中证大宗商品股票指数\(LOF\)/i,
      code: '161715',
      name: '招商大宗商品(LOF)'
    }
  ];

  const medianValue = (values: number[]) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  const adjustAmountByMedian = (value: number, raw: string | undefined, median: number | null) => {
    if (!median || median < 2000) return value;
    const rawText = String(raw || '').replace(/\s+/g, '');
    const intPart = rawText.split('.')[0]?.replace(/,/g, '') || '';
    if (intPart.length > 3 || value >= median / 2) return value;
    const candidates = [10, 100];
    let best = value;
    let bestDiff = Math.abs(value - median);
    for (const factor of candidates) {
      const scaled = value * factor;
      const diff = Math.abs(scaled - median);
      if (diff < bestDiff) {
        best = scaled;
        bestDiff = diff;
      }
    }
    return best;
  };

  const resizeScanImage = async (file: File, maxSize = 2000) => {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const scale = Math.min(1, maxSize / Math.max(width, height));
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    return await new Promise<Blob>((resolve) => {
      canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', 0.9);
    });
  };

  const enhanceScanImage = async (blob: Blob) => {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const contrast = 35;
    const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const next = factor * (lum - 128) + 128;
      data[i] = next;
      data[i + 1] = next;
      data[i + 2] = next;
    }
    ctx.putImageData(imageData, 0, 0);
    return await new Promise<Blob>((resolve) => {
      canvas.toBlob((out) => resolve(out || blob), 'image/jpeg', 0.92);
    });
  };

  const blobToBase64 = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('BASE64_FAIL'));
      reader.readAsDataURL(blob);
    });

  const recognizeWithGlm = async (blob: Blob) => {
    const image = await blobToBase64(blob);
    const resp = await fetch('/api/ocr/glm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image })
    });
    const data = await resp.json();
    if (!resp.ok || data?.error) {
      throw new Error(String(data?.error || 'GLM_OCR_FAIL'));
    }
    return Array.isArray(data?.funds) ? data.funds : [];
  };

  const openScanPick = () => setScanPickOpen(true);
  const closeScanPick = () => {
    if (!isScanning) setScanPickOpen(false);
  };

  const handleScanDragOver: DragEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isScanning) setScanDragging(true);
  };

  const handleScanDragLeave: DragEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!event.currentTarget.contains(event.relatedTarget as Node)) {
      setScanDragging(false);
    }
  };

  const handleScanDrop: DragEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setScanDragging(false);
    if (isScanning) return;
    const files = Array.from(event.dataTransfer.files || []).filter((file) =>
      SCAN_IMAGE_TYPES.includes(file.type)
    );
    if (files.length) handleScanFilesDrop(files);
  };

  const cancelScan = () => {
    abortScanRef.current = true;
    setIsScanning(false);
    setScanProgress({ stage: 'ocr', current: 0, total: 0 });
    if (scanInputRef.current) scanInputRef.current.value = '';
  };

  const processScanFiles = async (files: File[]) => {
    if (!files?.length) return;
    setIsScanning(true);
    setScanPickOpen(false);
    abortScanRef.current = false;
    setScanError('');
    setScanProgress({ stage: 'ocr', current: 0, total: files.length });

    try {
      const searchFundsWithTimeout = async (val: string, ms: number) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const timeout = new Promise<SearchItem[]>((resolve) => {
          timer = setTimeout(() => resolve([]), ms);
        });
        try {
          return await Promise.race([searchFundsClient(val, 8), timeout]) as SearchItem[];
        } catch {
          return [];
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      const parsedHoldings: Array<{ name: string; amount: number; profit: number; amountRaw?: string; profitRaw?: string }> = [];

      for (let i = 0; i < files.length; i += 1) {
        if (abortScanRef.current) break;
        const file = files[i];
        setScanProgress((prev) => ({ ...prev, current: i + 1 }));

        try {
          const resized = await resizeScanImage(file, 2000);
          const enhanced = await enhanceScanImage(resized);
          const glmHoldings = await recognizeWithGlm(enhanced);
          glmHoldings.forEach((item: any) => {
            const normalized = normalizeGlmHolding(item);
            if (normalized.name && normalized.amount !== null && normalized.profit !== null) {
              parsedHoldings.push({
                name: normalized.name,
                amount: normalized.amount,
                profit: normalized.profit,
                amountRaw: normalized.amountRaw,
                profitRaw: normalized.profitRaw
              });
            }
          });
        } catch (err: any) {
          const message = String(err?.message || '');
          if (message.includes('GLM_OCR_KEY_MISSING')) {
            throw err;
          }
          setScanError(message || '识别失败，请稍后重试');
        }
      }

      if (abortScanRef.current) return;

      if (!parsedHoldings.length) {
        setScanError('未识别到有效的持仓信息，请尝试更清晰的截图或确保包含完整列表。');
        setScannedFunds([]);
        setScanConfirmOpen(true);
        return;
      }

      const buildNameVariants = (raw: string) => {
        const normalized = normalizeOcrText(raw);
        const variants = new Set<string>();
        if (normalized) variants.add(normalized);
        OCR_NAME_ALIASES.forEach((alias) => {
          if (alias.pattern.test(normalized)) {
            variants.add(alias.name);
          }
        });
        const noParen = normalized.replace(/（[^）]*）|\([^)]*\)/g, '');
        if (noParen) variants.add(noParen);
        const noClass = noParen.replace(/([A-Z])(?:类)?$/i, '');
        if (noClass) variants.add(noClass);
        const noSuffix = noParen.replace(/(发起式|联接|混合|指数|股票|基金|增强|主题|策略|精选|成长|价值|配置|灵活|ETF|LOF|QDII)$/g, '');
        if (noSuffix) variants.add(noSuffix);
        const noSuffixClass = noSuffix.replace(/([A-Z])(?:类)?$/i, '');
        if (noSuffixClass) variants.add(noSuffixClass);
        const noIndex = noSuffixClass.replace(/(中证|上证|国证|沪深|深证|中债|全指|300|500|1000)/g, '');
        if (noIndex) variants.add(noIndex);
        const cjkOnly = noIndex.replace(/[^\u4e00-\u9fa5]/g, '');
        if (cjkOnly) variants.add(cjkOnly);
        if (cjkOnly.length > 6) {
          variants.add(cjkOnly.slice(0, 6));
          variants.add(cjkOnly.slice(-6));
        }
        if (cjkOnly.length > 4) {
          variants.add(cjkOnly.slice(0, 4));
          variants.add(cjkOnly.slice(-4));
        }
        return Array.from(variants).filter((item) => item.length >= 3);
      };

      const resolveByName = async (name: string) => {
        const normalized = normalizeOcrText(name);
        const aliasMatch = OCR_NAME_ALIASES.find((alias) => alias.pattern.test(normalized));
        if (aliasMatch) {
          return { code: aliasMatch.code, name: aliasMatch.name };
        }
        const variants = buildNameVariants(name);
        for (const variant of variants) {
          const list = await searchFundsWithTimeout(variant, 8000);
          if (Array.isArray(list) && list.length) {
            const exact = list.find((item) => item.name === name || item.name === variant);
            if (exact) return exact;
            const includes = list.find((item) => item.name.includes(variant) || variant.includes(item.name));
            return includes || list[0];
          }
        }
        for (const variant of variants) {
          const fuzzy = await resolveFundByFuzzy(variant);
          if (fuzzy?.code) return { code: fuzzy.code, name: fuzzy.name };
        }
        return null;
      };

      const mergedHoldings = new Map<string, { name: string; amount: number; profit: number }>();
      const unresolved: Array<{ code: string; name: string; status: 'invalid'; amount: number; profit: number }> = [];
      const cleanedHoldings = parsedHoldings
        .map((item) => ({
          name: normalizeOcrText(item.name),
          amount: item.amount,
          profit: item.profit,
          amountRaw: item.amountRaw
        }))
        .filter((item) => item.name && item.amount > 0 && item.profit !== null);

      const medianAmount = medianValue(cleanedHoldings.map((item) => item.amount));
      const adjustedHoldings = cleanedHoldings.map((item) => ({
        ...item,
        amount: adjustAmountByMedian(item.amount, item.amountRaw, medianAmount)
      }));

      setScanProgress({ stage: 'verify', current: 0, total: adjustedHoldings.length });
      for (let i = 0; i < adjustedHoldings.length; i += 1) {
        if (abortScanRef.current) break;
        const entry = adjustedHoldings[i];
        setScanProgress((prev) => ({ ...prev, current: i + 1 }));
        try {
          const resolved = await resolveByName(entry.name);
            if (resolved?.code) {
              const prev = mergedHoldings.get(resolved.code);
              if (!prev || entry.amount > prev.amount) {
                mergedHoldings.set(resolved.code, {
                  name: resolved.name || entry.name,
                  amount: entry.amount,
                  profit: entry.profit
                });
              }
            } else {
              unresolved.push({
                code: `unknown-${i}`,
                name: entry.name,
                status: 'invalid',
                amount: entry.amount,
                profit: entry.profit
              });
            }
          } catch {
            unresolved.push({
              code: `unknown-${i}`,
              name: entry.name,
              status: 'invalid',
              amount: entry.amount,
              profit: entry.profit
            });
          }
        }

      if (abortScanRef.current) return;

      const existingCodes = new Set([...holdings.map((h) => h.code)]);
      const results: Array<{ code: string; name: string; status: 'ok' | 'added' | 'invalid'; amount: number; profit: number }> = [
        ...Array.from(mergedHoldings.entries()).map<{
          code: string;
          name: string;
          status: 'ok' | 'added';
          amount: number;
          profit: number;
        }>(([code, value]) => ({
          code,
          name: value.name,
          amount: value.amount,
          profit: value.profit,
          status: existingCodes.has(code) ? ('added' as const) : ('ok' as const)
        })),
        ...unresolved
      ];

      setScannedFunds(results);
      setSelectedScannedCodes(new Set(results.filter((item) => item.status === 'ok').map((item) => item.code)));
      setScanConfirmOpen(true);
    } catch (err: any) {
      if (!abortScanRef.current) {
        const message = String(err?.message || '');
        if (message.includes('GLM_OCR_KEY_MISSING')) {
          setScanError('未配置 GLM API Key，无法识别截图。');
        } else {
          setScanError(message || '识别失败，请稍后重试');
        }
      }
    } finally {
      setIsScanning(false);
      setScanProgress({ stage: 'ocr', current: 0, total: 0 });
      if (scanInputRef.current) scanInputRef.current.value = '';
    }
  };

  const handleScanPick = () => {
    scanInputRef.current?.click();
  };

  const handleScanFilesUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    processScanFiles(files);
  };

  const handleScanFilesDrop = (files: File[]) => {
    processScanFiles(files);
  };

  const toggleScannedCode = (code: string) => {
    setSelectedScannedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const confirmScanImport = async () => {
    const selections = scannedFunds.filter(
      (item) =>
        selectedScannedCodes.has(item.code) &&
        item.status === 'ok' &&
        item.amount !== undefined &&
        item.profit !== undefined
    );
    if (!selections.length) return;
    setScanConfirmOpen(false);
    setIsScanImporting(true);
    setScanImportProgress({ current: 0, total: selections.length, success: 0, failed: 0 });

    try {
      for (let i = 0; i < selections.length; i += 1) {
        const entry = selections[i];
        const code = entry.code;
        setScanImportProgress((prev) => ({ ...prev, current: i + 1 }));
        if (holdings.some((item) => item.code === code)) continue;
        try {
          const amount = Number(entry.amount ?? 0);
          const profit = Number(entry.profit ?? 0);
          if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(profit)) {
            throw new Error('INVALID_OCR_VALUE');
          }
          const latestNav = fundCache[code]?.latestNav ?? null;
          const payload = buildHoldingPayload(
            code,
            'amount',
            {
              amount,
              profit,
              shares: null,
              costPrice: null,
              firstBuy: todayCn()
            },
            latestNav
          );
          saveHolding(payload, latestNav, true);
          ensureFundData(code);
          setScanImportProgress((prev) => ({ ...prev, success: prev.success + 1 }));
        } catch {
          setScanImportProgress((prev) => ({ ...prev, failed: prev.failed + 1 }));
        }
      }
    } finally {
      setIsScanImporting(false);
      setScanImportProgress({ current: 0, total: 0, success: 0, failed: 0 });
      setScannedFunds([]);
      setSelectedScannedCodes(new Set());
    }
  };

  async function resolveFeeRate(code: string) {
    const normalized = normalizeCode(code);
    if (!normalized) return null;
    const cached = fundCache[normalized]?.feeRate;
    if (cached !== null && cached !== undefined) return cached;
    try {
      let feeRate: number | null = null;
      if (USE_DIRECT_API) {
        feeRate = await getFundFeeRateClient(normalized);
      } else {
        const res = await fetch(`/api/fund/${normalized}/fee`);
        if (!res.ok) return null;
        const data = await res.json();
        feeRate = data?.feeRate ?? null;
      }
      setFundCache((prev) => ({
        ...prev,
        [normalized]: { ...ensureFundEntry(prev, normalized), feeRate }
      }));
      return feeRate;
    } catch {
      return null;
    }
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
    setHistoryOpen(false);

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
    setFundCache((prev) => ({ ...prev, [code]: { ...ensureFundEntry(prev, code), ...data } }));
  }

  async function refreshFeeRate(code: string) {
    const normalized = normalizeCode(code);
    if (!normalized) return;
    let feeRate: number | null = null;
    if (USE_DIRECT_API) {
      feeRate = await getFundFeeRateClient(normalized);
    } else {
      const res = await fetch(`/api/fund/${normalized}/fee`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data) return;
      feeRate = data.feeRate ?? null;
    }
    setFundCache((prev) => ({
      ...prev,
      [normalized]: { ...ensureFundEntry(prev, normalized), feeRate }
    }));
  }

  async function ensureFundExtras(code: string, page = historyPage) {
    const hasPositions = positionCache[code] !== undefined;
    const historyKey = `${code}_${page}`;
    const hasHistoryTable = historyTableCache[historyKey] !== undefined;
    if (hasPositions && hasHistoryTable) return;
    if (extrasPendingRef.current.has(historyKey)) return;
    extrasPendingRef.current.add(historyKey);

    setExtrasLoading(true);
    if (USE_DIRECT_API) {
      const [positionsRes, historyRes] = await Promise.allSettled([
        getFundPositionsClient(code),
        getFundHistoryTableClient(code, page)
      ]);

      if (positionsRes.status === 'fulfilled') {
        setPositionCache((prev) => ({ ...prev, [code]: positionsRes.value }));
      } else if (!hasPositions) {
        setPositionCache((prev) => ({ ...prev, [code]: null }));
      }

      if (historyRes.status === 'fulfilled') {
        setHistoryTableCache((prev) => ({ ...prev, [historyKey]: historyRes.value }));
      } else if (!hasHistoryTable) {
        setHistoryTableCache((prev) => ({ ...prev, [historyKey]: null }));
      }
    } else {
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
    }

    setExtrasLoading(false);
    extrasPendingRef.current.delete(historyKey);
  }

  async function ensureFundPerformance(code: string, period: string) {
    const key = `${code}:${period}`;
    if (performanceCache[key] !== undefined) return;
    try {
      if (USE_DIRECT_API) {
        const performance = await getFundPerformanceClient(code, period);
        setPerformanceCache((prev) => ({ ...prev, [key]: performance }));
      } else {
        const res = await fetch(`/api/fund/${code}/performance?period=${encodeURIComponent(period)}`);
        if (!res.ok) {
          setPerformanceCache((prev) => ({ ...prev, [key]: null }));
          return;
        }
        const data = await res.json();
        const performance = data && data.period ? data : data?.performance || null;
        setPerformanceCache((prev) => ({ ...prev, [key]: performance }));
      }
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
    if (historyPages <= 1) return;
    const nextPage = historyPage + 1;
    if (nextPage > historyPages) return;
    const historyKey = `${selectedCode}_${nextPage}`;
    if (historyTableCache[historyKey] !== undefined) return;
    ensureFundExtras(selectedCode, nextPage);
  }, [historyPage, historyPages, selectedCode, historyTableCache]);

  useEffect(() => {
    if (!selectedCode) return;
    ensureFundPerformance(selectedCode, performancePeriod);
  }, [selectedCode, performancePeriod]);

  function closeModal() {
    setSelectedCode(null);
    setSelectedSource(null);
    setHistoryOpen(false);
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
    let removedHolding = false;

    if (selectedSource === 'holding') {
      removedHolding = true;
      setHoldings((prev) => prev.filter((item) => item.code !== code));
    } else if (selectedSource === 'watchlist') {
      setWatchlist((prev) => prev.filter((item) => item !== code));
    } else if (inHoldings && !inWatch) {
      removedHolding = true;
      setHoldings((prev) => prev.filter((item) => item.code !== code));
    } else if (!inHoldings && inWatch) {
      setWatchlist((prev) => prev.filter((item) => item !== code));
    } else if (inHoldings && inWatch) {
      removedHolding = true;
      setHoldings((prev) => prev.filter((item) => item.code !== code));
    }

    if (removedHolding) {
      setOperations((prev) => prev.filter((op) => op.code !== code));
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
      nav?: number | null;
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
      nav: meta.nav ?? null,
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
      nav?: number | null;
      date?: string;
      timing: TradeTiming;
    }
  ) {
    if (!selectedCode) return;
    const code = selectedCode;
    const latestNav = selectedData?.latestNav ?? null;
    const tradeNav = values.nav ?? latestNav;
    const prev = holdings.find((item) => item.code === code) || null;
    const method: 'amount' | 'shares' =
      prev?.method || (values.shares !== null && values.shares !== undefined ? 'shares' : 'amount');
    if (type === 'reduce' && !prev) return;
    const date = values.date || todayCn();
    const timing = values.timing || 'before';
    const isQdii = isQdiiFund(selectedData?.name);

    const baseAmount =
      toNumber(prev?.amount) ?? (prev?.shares && latestNav ? prev.shares * latestNav : 0);
    const baseProfit =
      toNumber(prev?.profit) ??
      (prev?.shares && prev?.costPrice !== null && prev?.costPrice !== undefined && latestNav
        ? (latestNav - prev.costPrice) * prev.shares
        : 0);
    const baseShares =
      toNumber(prev?.shares) ?? (prev?.amount && latestNav ? prev.amount / latestNav : 0);

    if (type === 'reduce' && method === 'shares' && baseShares <= 0) return;
    if (type === 'reduce' && method === 'amount' && baseAmount <= 0) return;

    const deltaAmount =
      values.amount !== null && values.amount !== undefined
        ? values.amount
        : values.shares !== null && values.shares !== undefined && tradeNav
          ? values.shares * tradeNav
          : 0;
    const deltaShares =
      values.shares !== null && values.shares !== undefined
        ? values.shares
        : values.amount !== null && values.amount !== undefined && tradeNav
          ? values.amount / tradeNav
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
      method,
      nav: values.nav ?? null
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

  async function handleTradeAdd(values: { amount: string; feeRate: string; date: string; timing: TradeTiming }) {
    const amount = toNumber(values.amount);
    if (amount === null || amount <= 0) return;
    const date = values.date || todayCn();
    const timing = values.timing || 'before';
    if (!selectedCode) return;
    const navFromTable = await resolveNavForOp(selectedCode, date, timing);
    if (navFromTable === null) {
      window.alert('未找到该日期的净值数据，无法计算加仓。');
      return;
    }
    const shares = Number((amount / navFromTable).toFixed(2));
    handleTrade('add', {
      amount,
      shares,
      feeRate: toNumber(values.feeRate),
      nav: navFromTable,
      date,
      timing
    });
  }

  async function handleTradeReduce(values: { shares: string; fee: string; date: string; timing: TradeTiming }) {
    const shares = toNumber(values.shares);
    if (shares === null || shares <= 0) return;
    const date = values.date || todayCn();
    const timing = values.timing || 'before';
    if (!selectedCode) return;
    const navFromTable = await resolveNavForOp(selectedCode, date, timing);
    if (navFromTable === null) {
      window.alert('未找到该日期的净值数据，无法计算减仓。');
      return;
    }
    const navForTrade = navFromTable;
    const amount = navForTrade ? Number((shares * navForTrade).toFixed(2)) : null;
    handleTrade('reduce', {
      shares,
      amount,
      fee: toNumber(values.fee),
      nav: navForTrade,
      date,
      timing
    });
  }

  async function applyBatchImport(
    code: string,
    items: BatchTradeInput[],
    options: { updateForm?: boolean; feeRate?: number | null } = {}
  ) {
    const normalized = normalizeCode(code);
    if (!normalized) return;
    if (!items.length) return;
    const latestNav =
      (normalized === selectedCode ? selectedData?.latestNav : null) ?? fundCache[normalized]?.latestNav ?? null;
    let tempHolding = holdings.find((item) => item.code === normalized) || null;
    const sorted = items.slice().sort((a, b) => {
      const dateA = `${a.date || ''} ${a.time || ''}`.trim();
      const dateB = `${b.date || ''} ${b.time || ''}`.trim();
      return dateA.localeCompare(dateB);
    });
    const newOps: FundOperation[] = [];
    const isQdii = isQdiiFund(
      normalized === selectedCode ? selectedData?.name : fundCache[normalized]?.name
    );
    for (const item of sorted) {
      const date = item.date || todayCn();
      const timing = item.timing || 'before';
      const nav = await resolveNavForOp(normalized, date, timing);
      if (!nav) continue;
      let amount = item.amount ?? null;
      let shares = item.shares ?? null;
      if (amount === null && shares !== null) {
        amount = Number((shares * nav).toFixed(2));
      }
      if (shares === null && amount !== null) {
        shares = Number((amount / nav).toFixed(2));
      }
      if (amount === null && shares === null) continue;
      const method: 'amount' | 'shares' =
        tempHolding?.method || (shares !== null && shares !== undefined ? 'shares' : 'amount');
      const baseAmount =
        toNumber(tempHolding?.amount) ??
        (tempHolding?.shares && latestNav ? tempHolding.shares * latestNav : 0);
      const baseProfit =
        toNumber(tempHolding?.profit) ??
        (tempHolding?.shares &&
        tempHolding?.costPrice !== null &&
        tempHolding?.costPrice !== undefined &&
        latestNav
          ? (latestNav - tempHolding.costPrice) * tempHolding.shares
          : 0);
      const baseShares =
        toNumber(tempHolding?.shares) ??
        (tempHolding?.amount && latestNav ? tempHolding.amount / latestNav : 0);

      if (item.type === 'reduce' && method === 'shares' && baseShares <= 0) continue;
      if (item.type === 'reduce' && method === 'amount' && baseAmount <= 0) continue;

      const tradeNav = nav;
      const deltaAmount =
        amount !== null && amount !== undefined
          ? amount
          : shares !== null && shares !== undefined && tradeNav
            ? shares * tradeNav
            : 0;
      const deltaShares =
        shares !== null && shares !== undefined
          ? shares
          : amount !== null && amount !== undefined && tradeNav
            ? amount / tradeNav
            : 0;

      let nextHolding: Holding | null = null;
      if (method === 'shares') {
        const delta = deltaShares || 0;
        let nextShares = item.type === 'add' ? baseShares + delta : baseShares - delta;
        nextShares = Number(nextShares.toFixed(2));
        if (nextShares > 0) {
          const costPrice = tempHolding?.costPrice ?? null;
          const firstBuy = tempHolding?.firstBuy || date || '';
          nextHolding = buildHoldingPayload(
            normalized,
            'shares',
            { amount: null, profit: null, shares: nextShares, costPrice, firstBuy },
            latestNav
          );
        }
      } else {
        const delta = deltaAmount || 0;
        let nextAmount = item.type === 'add' ? baseAmount + delta : baseAmount - delta;
        nextAmount = Number(nextAmount.toFixed(2));
        if (nextAmount > 0) {
          let nextProfit = baseProfit;
          if (item.type === 'reduce' && baseAmount > 0) {
            nextProfit = baseProfit * (nextAmount / baseAmount);
          }
          const firstBuy = tempHolding?.firstBuy || date || '';
          nextHolding = buildHoldingPayload(
            normalized,
            'amount',
            { amount: nextAmount, profit: nextProfit, shares: null, costPrice: null, firstBuy },
            latestNav
          );
        }
      }

      const feeRate = options.feeRate ?? null;
      const feeValue =
        item.type === 'add' && feeRate !== null && feeRate !== undefined && amount !== null && amount !== undefined
          ? Number(((amount * feeRate) / 100).toFixed(2))
          : 0;
      const op = buildTradeOperation(item.type, tempHolding, nextHolding, {
        amount,
        shares,
        feeRate: item.type === 'add' ? feeRate : null,
        fee: feeValue,
        date,
        timing,
        isQdii,
        method,
        nav
      });
      newOps.push(op);
      tempHolding = nextHolding;
    }

    if (!newOps.length) return;
    suppressAutoSaveRef.current = true;
    if (tempHolding) {
      setHoldings((prev) => {
        const next = prev.filter((item) => item.code !== normalized);
        next.push(tempHolding as Holding);
        return next;
      });
      if (options.updateForm) {
        setForm(buildFormFromHolding(tempHolding, latestNav));
        setHoldingMethod(tempHolding.method);
      }
    } else {
      setHoldings((prev) => prev.filter((item) => item.code !== normalized));
      if (options.updateForm) {
        setForm(buildFormFromHolding(null, latestNav));
      }
    }
    setOperations((prev) => {
      const next = [...newOps, ...prev];
      return next.length > 200 ? next.slice(0, 200) : next;
    });
  }

  async function handleBatchImport(items: BatchTradeInput[]) {
    if (!selectedCode) return;
    await applyBatchImport(selectedCode, items, { updateForm: true });
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

  function buildExportPayload() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        holdings,
        watchlist,
        operations
      }
    };
  }

  function formatExportDate(value: Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  function handleExport() {
    if (typeof window === 'undefined') return;
    const payload = buildExportPayload();
    const content = JSON.stringify(payload, null, 2);
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `fund-tracker-export-${formatExportDate(new Date())}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function handleImportFile(file: File) {
    if (!file) return;
    const text = await file.text();
    let payload: any = null;
    try {
      payload = JSON.parse(text);
    } catch {
      window.alert('导入失败：文件不是有效 JSON');
      return;
    }

    const source = payload?.data ?? payload;
    const rawHoldings = Array.isArray(source?.holdings) ? source.holdings : [];
    const rawWatchlist = Array.isArray(source?.watchlist) ? source.watchlist : [];
    const rawOperations = Array.isArray(source?.operations) ? source.operations : [];

    if (!rawHoldings.length && !rawWatchlist.length && !rawOperations.length) {
      window.alert('导入失败：未找到可用的数据字段');
      return;
    }

    if (!window.confirm('导入会覆盖当前账户资产、持仓和自选数据，是否继续？')) return;

    const normalizedHoldings = rawHoldings
      .map((item: any) => {
        const code = normalizeCode(item?.code);
        if (!code) return null;
        const method = item?.method || (item?.shares || item?.costPrice ? 'shares' : 'amount');
        return {
          code,
          method,
          amount: toNumber(item?.amount),
          profit: toNumber(item?.profit),
          shares: toNumber(item?.shares),
          costPrice: toNumber(item?.costPrice),
          firstBuy: item?.firstBuy || ''
        } as Holding;
      })
      .filter(Boolean) as Holding[];

    const normalizedWatchlist = rawWatchlist
      .map((code: string) => normalizeCode(code))
      .filter(Boolean) as string[];

    const normalizedOperations = rawOperations
      .map((item: any) => {
        const code = normalizeCode(item?.code);
        if (!code) return null;
        const type = item?.type;
        if (type !== 'add' && type !== 'reduce' && type !== 'edit') return null;
        const createdAt = Number(item?.createdAt);
        const applyAt = Number(item?.applyAt);
        const nextOp: FundOperation = {
          id: item?.id || createOperationId(),
          code,
          type,
          status: item?.status === 'pending' || item?.status === 'confirmed' ? item.status : 'confirmed',
          createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
          applyAt: Number.isFinite(applyAt) ? applyAt : Date.now(),
          method: item?.method,
          amount: item?.amount ?? null,
          shares: item?.shares ?? null,
          nav: item?.nav ?? null,
          feeRate: item?.feeRate ?? null,
          fee: item?.fee ?? null,
          date: item?.date,
          timing: item?.timing,
          isQdii: item?.isQdii,
          prev: item?.prev ?? null,
          next: item?.next ?? null
        };
        return nextOp;
      })
      .filter(Boolean) as FundOperation[];

    setHoldings(normalizedHoldings);
    setWatchlist(normalizedWatchlist);
    setOperations(normalizedOperations);
    setSelectedCode(null);
    setSelectedSource(null);
    setHistoryPage(1);
    setHistoryOpen(false);
  }

  function handleImportClick() {
    importInputRef.current?.click();
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
          <div className="refresh-select">
            <select
              aria-label="自动刷新频率"
              value={refreshInterval}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (!Number.isFinite(value)) return;
                setRefreshInterval(value);
                refreshData();
              }}
            >
              {REFRESH_INTERVALS.map((item) => (
                <option key={item.value} value={item.value}>
                  刷新频率 {item.label}
                </option>
              ))}
            </select>
          </div>
          <button className="btn secondary" type="button" onClick={handleExport}>
            导出
          </button>
          <button className="btn" type="button" onClick={handleImportClick}>
            导入
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={async (event) => {
              const file = event.target.files?.[0] || null;
              event.target.value = '';
              if (!file) return;
              await handleImportFile(file);
            }}
          />
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
                <strong id="hero-asset">
                  {holdingsSummary.totalAsset === null ? '-' : formatMoneyWithSymbol(holdingsSummary.totalAsset)}
                </strong>
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
        <div className="section-head">
          <div>
            <h3>持仓基金</h3>
          </div>
          <div className="view-toggle">
            <button
              type="button"
              className="mini-btn mini-btn--icon"
              onClick={openScanPick}
              aria-label="截图识别"
              title="截图识别"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <circle cx="9" cy="11" r="2.2" />
                <path d="M3 17l5-4 4 3 4-5 5 6" />
              </svg>
            </button>
            <button
              type="button"
              className={`mini-btn ${holdingViewMode === 'card' ? 'active' : ''}`}
              onClick={() => setHoldingViewMode('card')}
              aria-pressed={holdingViewMode === 'card'}
              aria-label="卡片视图"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="3" width="8" height="8" rx="2" />
                <rect x="13" y="3" width="8" height="8" rx="2" />
                <rect x="3" y="13" width="8" height="8" rx="2" />
                <rect x="13" y="13" width="8" height="8" rx="2" />
              </svg>
            </button>
            <button
              type="button"
              className={`mini-btn ${holdingViewMode === 'table' ? 'active' : ''}`}
              onClick={() => setHoldingViewMode('table')}
              aria-pressed={holdingViewMode === 'table'}
              aria-label="表格视图"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M3 9h18M3 14h18M8 4v16" />
              </svg>
            </button>
          </div>
        </div>
        {holdingViewMode === 'card' ? (
          <div className="fund-treemap" id="fund-grid" ref={treemapRef}>
            {!holdings.length && <div className="empty-state">还没有持仓基金，请从顶部搜索添加。</div>}
            {treemapTiles.map((tile) => {
              const pct = tile.item.pct;
              const pctClass =
                pct === null || pct === undefined ? 'tile-flat' : pct >= 0 ? 'tile-up' : 'tile-down';
              const absPct = pct === null || pct === undefined ? 0 : Math.min(Math.abs(pct) / 3, 1);
              let tileColor: string | undefined;
              if (pct === null || pct === undefined) {
                tileColor = '#4b505e';
              } else if (pct >= 0) {
                const light = 68 - absPct * 28;
                tileColor = `hsl(350, 65%, ${light}%)`;
              } else {
                const light = 58 - absPct * 20;
                tileColor = `hsl(145, 45%, ${light}%)`;
              }
              const isTiny = tile.w * tile.h < 2600;
              return (
                <FundCard
                  key={tile.item.code}
                  variant="holding"
                  code={tile.item.code}
                  data={fundCache[tile.item.code]}
                  holding={tile.item.holding}
                  className={`fund-card--tile ${pctClass} ${isTiny ? 'tile--tiny' : ''}`}
                  style={{
                    left: `${tile.x}px`,
                    top: `${tile.y}px`,
                    width: `${tile.w}px`,
                    height: `${tile.h}px`,
                    backgroundColor: tileColor
                  }}
                  onOpen={() => openModal(tile.item.code, 'holding')}
                />
              );
            })}
          </div>
        ) : (
          <div className="fund-list" id="fund-list">
            {!holdings.length && <div className="empty-state">还没有持仓基金，请从顶部搜索添加。</div>}
            {!!holdings.length && (
              <div className="fund-row fund-row--header">
                <div className="fund-row-main">
                  <div className="fund-row-title">基金名称 / 代码</div>
                </div>
                <div className="fund-row-metric">
                  <span>持有金额</span>
                </div>
                <div className="fund-row-metric">
                  <span>持有收益</span>
                </div>
                <div className="fund-row-metric">
                  <span>当日收益</span>
                </div>
              </div>
            )}
            {holdings.map((holding) => {
              const data = fundCache[holding.code];
              const view = computeHoldingView(holding, data);
              const dailyPct = resolveDailyPct(data);
              const dailyProfit =
                view.amount !== null && view.amount !== undefined && dailyPct !== null
                  ? (view.amount * dailyPct) / 100
                  : null;
              const holdingRate =
                view.amount !== null &&
                view.amount !== undefined &&
                view.profit !== null &&
                view.profit !== undefined &&
                view.amount - view.profit !== 0
                  ? (view.profit / (view.amount - view.profit)) * 100
                  : null;
              const dailyClass = classByValue(dailyProfit);
              const dailyRateClass = classByValue(dailyPct ?? null);
              const profitClass = classByValue(view.profit ?? null);
              const holdingRateClass = classByValue(holdingRate);
              return (
                <div
                  key={holding.code}
                  className="fund-row fund-row--compact"
                  role="button"
                  tabIndex={0}
                  onClick={() => openModal(holding.code, 'holding')}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') openModal(holding.code, 'holding');
                  }}
                >
                  <div className="fund-row-main">
                    <div className="fund-row-title">{data?.name || holding.code}</div>
                    <div className="fund-row-code">{holding.code}</div>
                  </div>
                  <div className="fund-row-metric">
                    <strong>{formatMoneyWithSymbol(view.amount ?? null)}</strong>
                  </div>
                  <div className="fund-row-metric">
                    <strong className={profitClass}>{formatMoney(view.profit ?? null)}</strong>
                    <em className={`fund-row-sub ${holdingRateClass}`}>{formatPct(holdingRate)}</em>
                  </div>
                  <div className="fund-row-metric">
                    <strong className={dailyClass}>{formatMoney(dailyProfit)}</strong>
                    <em className={`fund-row-sub ${dailyRateClass}`}>{formatPct(dailyPct ?? null)}</em>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="section reveal">
        <h3>自选基金</h3>
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

      <input
        ref={scanInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleScanFilesUpload}
        style={{ display: 'none' }}
      />

      {scanPickOpen && (
        <div className="submodal">
          <div className="submodal-backdrop" onClick={closeScanPick} />
          <div className="submodal-card scan-card">
            <div className="submodal-header scan-header">
              <h4>选择持仓截图</h4>
              <button className="mini-btn" onClick={closeScanPick}>关闭</button>
            </div>
            <div
              className={`scan-dropzone ${scanDragging ? 'dragging' : ''}`}
              onDragOver={handleScanDragOver}
              onDragLeave={handleScanDragLeave}
              onDrop={handleScanDrop}
              onClick={!isScanning ? handleScanPick : undefined}
            >
              {scanDragging ? '松开即可导入' : '拖拽图片到此处，或点击选择'}
            </div>
            <div className="scan-actions">
              <button className="btn secondary" onClick={closeScanPick}>
                取消
              </button>
              <button className="btn" onClick={handleScanPick} disabled={isScanning}>
                {isScanning ? '处理中…' : '选择图片'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isScanning && (
        <div className="submodal">
          <div className="submodal-backdrop" />
          <div className="submodal-card scan-progress-card">
            <div className="loading-indicator scan-spinner" />
            <div className="scan-progress-title">
              {scanProgress.stage === 'verify' ? '正在验证基金…' : '正在识别中…'}
            </div>
            {scanProgress.total > 0 && (
              <div className="scan-progress-meta">
                {scanProgress.stage === 'verify'
                  ? `已验证 ${scanProgress.current} / ${scanProgress.total} 只基金`
                  : `已处理 ${scanProgress.current} / ${scanProgress.total} 张图片`}
              </div>
            )}
            <button className="btn danger" onClick={cancelScan}>
              终止识别
            </button>
          </div>
        </div>
      )}

      {scanConfirmOpen && (
        <div className="submodal">
          <div className="submodal-backdrop" onClick={() => setScanConfirmOpen(false)} />
          <div className="submodal-card scan-confirm-card">
            <div className="submodal-header scan-header">
              <h4>确认导入持仓</h4>
              <button className="mini-btn" onClick={() => setScanConfirmOpen(false)}>关闭</button>
            </div>
            {scannedFunds.length === 0 ? (
              <div className="scan-desc">
                {scanError || '未识别到有效的持仓信息，请尝试更清晰的截图或重新截取完整列表。'}
              </div>
            ) : (
              <div className="scan-list">
                {scannedFunds.map((item) => {
                  const isSelected = selectedScannedCodes.has(item.code);
                  const isAdded = item.status === 'added';
                  const isInvalid = item.status === 'invalid';
                  const hasMetrics = item.amount !== undefined && item.profit !== undefined;
                  const isDisabled = isAdded || isInvalid || !hasMetrics;
                  const codeLabel = item.code.startsWith('unknown-') ? '未识别代码' : `#${item.code}`;
                  return (
                    <button
                      key={item.code}
                      type="button"
                      className={`scan-item ${isSelected ? 'selected' : ''} ${isAdded ? 'added' : ''}`}
                      onClick={() => {
                        if (!isDisabled) toggleScannedCode(item.code);
                      }}
                      disabled={isDisabled}
                    >
                      <div className="scan-item-info">
                        <strong>{item.name || (isInvalid ? '未找到基金' : '未知基金')}</strong>
                        <span>{codeLabel}</span>
                      </div>
                      <div className="scan-item-metrics">
                        <strong>{formatMoney(item.amount ?? null)}</strong>
                        <span className={classByValue(item.profit ?? null)}>
                          {formatSignedMoney(item.profit ?? null)}
                        </span>
                      </div>
                      {isAdded ? (
                        <span className="scan-tag">已添加</span>
                      ) : isInvalid ? (
                        <span className="scan-tag">未找到</span>
                      ) : !hasMetrics ? (
                        <span className="scan-tag">缺少金额/收益</span>
                      ) : (
                        <span className="scan-check">{isSelected ? '已选' : '选择'}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="scan-actions">
              <button className="btn secondary" onClick={() => setScanConfirmOpen(false)}>
                取消
              </button>
              <button className="btn" onClick={confirmScanImport} disabled={selectedScannedCodes.size === 0}>
                确认导入
              </button>
            </div>
          </div>
        </div>
      )}

      {isScanImporting && (
        <div className="submodal">
          <div className="submodal-backdrop" />
          <div className="submodal-card scan-progress-card">
            <div className="loading-indicator scan-spinner" />
            <div className="scan-progress-title">正在导入持仓…</div>
            {scanImportProgress.total > 0 && (
              <div className="scan-progress-meta">
                进度 {scanImportProgress.current} / {scanImportProgress.total}
              </div>
            )}
            <div className="scan-progress-meta">
              成功 {scanImportProgress.success}，失败 {scanImportProgress.failed}
            </div>
          </div>
        </div>
      )}

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
        historyOpen={historyOpen}
        onHistoryOpenChange={setHistoryOpen}
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
        onBatchImport={handleBatchImport}
        chartRange={chartRange}
        onChartRangeChange={setChartRange}
        onPerformancePeriodChange={setPerformancePeriod}
      />

      <div className="footnote">数据来源：东方财富。仅供参考，不构成投资建议。</div>
    </div>
  );
}
