'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { classByValue, containsCjk, formatMoney, formatMoneyWithSymbol, formatPct, normalizeCode, toNumber } from '../../lib/utils';
import { computeCostUnit, computeHoldingView, computeMetrics } from '../../lib/metrics';
import { detectFundFromText, parseBatchText } from '../../lib/ocr';
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [holdingViewMode, setHoldingViewMode] = useState<'card' | 'table'>('card');

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchItem[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);

  const [quickImportOpen, setQuickImportOpen] = useState(false);
  const [quickImportSource, setQuickImportSource] = useState<string | null>(null);
  const [quickImportTarget, setQuickImportTarget] = useState('');
  const [quickImportDetected, setQuickImportDetected] = useState('');
  const [quickImportResolved, setQuickImportResolved] = useState<{ code: string; name: string } | null>(null);
  const [, setQuickImportImage] = useState<File | null>(null);
  const [quickImportPreview, setQuickImportPreview] = useState('');
  const [quickImportText, setQuickImportText] = useState('');
  const [quickImportLoading, setQuickImportLoading] = useState(false);
  const [quickImportItems, setQuickImportItems] = useState<BatchTradeInput[]>([]);
  const [quickImportSelected, setQuickImportSelected] = useState<Record<string, boolean>>({});
  const [quickImportEdits, setQuickImportEdits] = useState<Record<string, { amount: string; shares: string }>>({});
  const quickImportSearchTimerRef = useRef<number | null>(null);

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

  useEffect(() => {
    historyCacheRef.current = historyTableCache;
  }, [historyTableCache]);

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
  const quickImportOptions = useMemo(() => {
    const map = new Map<string, string>();
    fundCandidates.forEach((item) => {
      map.set(item.code, item.name || item.code);
    });
    if (quickImportResolved && !map.has(quickImportResolved.code)) {
      map.set(quickImportResolved.code, quickImportResolved.name || quickImportResolved.code);
    }
    return Array.from(map.entries()).map(([code, name]) => ({ code, name }));
  }, [fundCandidates, quickImportResolved]);
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
          const res = await fetch(`/api/fund/${code}/history-table?page=${page}`);
          if (!res.ok) return null;
          const data = await res.json();
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

  function openQuickImport(code?: string) {
    setQuickImportSource(code ?? null);
    setQuickImportTarget(code ?? '');
    setQuickImportDetected(code ?? '');
    if (code) {
      const name = fundCache[code]?.name || code;
      setQuickImportResolved({ code, name });
    } else {
      setQuickImportResolved(null);
    }
    setQuickImportImage(null);
    setQuickImportPreview('');
    setQuickImportText('');
    setQuickImportItems([]);
    setQuickImportSelected({});
    setQuickImportEdits({});
    setQuickImportLoading(false);
    setQuickImportOpen(true);
  }

  function closeQuickImport() {
    if (quickImportSearchTimerRef.current) {
      window.clearTimeout(quickImportSearchTimerRef.current);
      quickImportSearchTimerRef.current = null;
    }
    setQuickImportOpen(false);
  }

  const shouldLookupFund = (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return false;
    if (/^\d+$/.test(trimmed)) return trimmed.length >= 6;
    return trimmed.length >= 2;
  };

  const lookupFundForQuickImport = async (query: string, showAlert = true) => {
    const trimmed = query.trim();
    if (!trimmed) {
      setQuickImportTarget('');
      setQuickImportResolved(null);
      return;
    }
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`);
      if (!res.ok) return;
      const list = await res.json();
      if (!Array.isArray(list) || !list.length) {
        setQuickImportTarget('');
        setQuickImportResolved(null);
        if (showAlert) window.alert('未找到该基金');
        return;
      }
      let picked = list[0];
      if (/^\d{6}$/.test(trimmed)) {
        const exact = list.find((item) => item.code === trimmed);
        if (exact) picked = exact;
      }
      setQuickImportTarget(picked.code);
      setQuickImportResolved({ code: picked.code, name: picked.name || picked.code });
    } catch {
      // ignore
    }
  };

  const parseNumericInput = (value: string) => {
    const cleaned = value.replace(/,/g, '').trim();
    if (!cleaned) return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  };

  const updateQuickValue = (id: string, field: 'amount' | 'shares', value: string) => {
    setQuickImportEdits((prev) => ({
      ...prev,
      [id]: { amount: prev[id]?.amount ?? '', shares: prev[id]?.shares ?? '', [field]: value }
    }));
    const parsed = parseNumericInput(value);
    setQuickImportItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: parsed } : item))
    );
  };

  const handleQuickFileChange = (event: any) => {
    const file = event.target.files?.[0] || null;
    setQuickImportImage(file);
    if (!file) {
      setQuickImportPreview('');
      setQuickImportItems([]);
      setQuickImportSelected({});
      setQuickImportEdits({});
      setQuickImportText('');
      setQuickImportDetected('');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setQuickImportPreview(String(reader.result || ''));
    };
    reader.readAsDataURL(file);
    handleQuickOcr(file);
  };

  const handleQuickOcr = async (file: File) => {
    setQuickImportLoading(true);
    try {
      const Tesseract = await import('tesseract.js');
      const result = await Tesseract.recognize(file, 'chi_sim');
      const text = result?.data?.text || '';
      setQuickImportText(text);
      const items = parseBatchText(text);
      setQuickImportItems(items);
      const edits: Record<string, { amount: string; shares: string }> = {};
      items.forEach((item) => {
        edits[item.id] = {
          amount: item.amount !== null && item.amount !== undefined ? String(item.amount) : '',
          shares: item.shares !== null && item.shares !== undefined ? String(item.shares) : ''
        };
      });
      setQuickImportEdits(edits);
      const selected: Record<string, boolean> = {};
      items.forEach((item) => {
        selected[item.id] = true;
      });
      setQuickImportSelected(selected);

      const detected = detectFundFromText(text, fundCandidates);
      const detectedCode = detected?.code || '';
      setQuickImportDetected(detectedCode);
      if (detectedCode) {
        if (shouldLookupFund(detectedCode)) {
          await lookupFundForQuickImport(detectedCode, true);
        } else {
          setQuickImportTarget('');
          setQuickImportResolved(null);
        }
      } else if (quickImportSource) {
        setQuickImportDetected(quickImportSource);
        setQuickImportTarget(quickImportSource);
        setQuickImportResolved({
          code: quickImportSource,
          name: fundCache[quickImportSource]?.name || quickImportSource
        });
      } else {
        setQuickImportTarget('');
        setQuickImportResolved(null);
      }
    } catch {
      setQuickImportText('');
      setQuickImportItems([]);
      setQuickImportSelected({});
      setQuickImportEdits({});
      setQuickImportDetected('');
      setQuickImportResolved(null);
    } finally {
      setQuickImportLoading(false);
    }
  };

  async function resolveFeeRate(code: string) {
    const normalized = normalizeCode(code);
    if (!normalized) return null;
    const cached = fundCache[normalized]?.feeRate;
    if (cached !== null && cached !== undefined) return cached;
    try {
      const res = await fetch(`/api/fund/${normalized}/fee`);
      if (!res.ok) return null;
      const data = await res.json();
      const feeRate = data?.feeRate ?? null;
      setFundCache((prev) => ({
        ...prev,
        [normalized]: { ...(prev[normalized] || {}), feeRate }
      }));
      return feeRate;
    } catch {
      return null;
    }
  }

  const handleQuickImport = async () => {
    if (!quickImportTarget) return;
    const selectedItems = quickImportItems.filter((item) => quickImportSelected[item.id]);
    if (!selectedItems.length) return;
    const feeRate = await resolveFeeRate(quickImportTarget);
    await applyBatchImport(quickImportTarget, selectedItems, {
      updateForm: quickImportTarget === selectedCode,
      feeRate
    });
    closeQuickImport();
  };

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
    if (extrasPendingRef.current.has(historyKey)) return;
    extrasPendingRef.current.add(historyKey);

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
    extrasPendingRef.current.delete(historyKey);
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
        (tempHolding?.shares && latestNav ? tempHolding.shares * latestNav : 0) ??
        0;
      const baseProfit =
        toNumber(tempHolding?.profit) ??
        (tempHolding?.shares &&
        tempHolding?.costPrice !== null &&
        tempHolding?.costPrice !== undefined &&
        latestNav
          ? (latestNav - tempHolding.costPrice) * tempHolding.shares
          : 0) ??
        0;
      const baseShares =
        toNumber(tempHolding?.shares) ??
        (tempHolding?.amount && latestNav ? tempHolding.amount / latestNav : 0) ??
        0;

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
              className="mini-btn mini-btn--wide"
              onClick={() => openQuickImport()}
              aria-label="截图添加"
            >
              截图添加
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
        ) : (
          <div className="fund-list" id="fund-list">
            {!holdings.length && <div className="empty-state">还没有持仓基金，请从顶部搜索添加。</div>}
            {holdings.map((holding) => {
              const data = fundCache[holding.code];
              const view = computeHoldingView(holding, data);
              const dailyPct = deriveDailyPct(data);
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
                  className="fund-row"
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
                    <span>持有金额</span>
                    <strong>{formatMoneyWithSymbol(view.amount ?? null)}</strong>
                  </div>
                  <div className="fund-row-metric">
                    <span>当日收益</span>
                    <strong className={dailyClass}>{formatMoney(dailyProfit)}</strong>
                    <em className={`fund-row-sub ${dailyRateClass}`}>{formatPct(dailyPct ?? null)}</em>
                  </div>
                  <div className="fund-row-metric">
                    <span>持有收益</span>
                    <strong className={profitClass}>{formatMoney(view.profit ?? null)}</strong>
                    <em className={`fund-row-sub ${holdingRateClass}`}>{formatPct(holdingRate)}</em>
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

      {quickImportOpen && (
        <div className="submodal">
          <div className="submodal-backdrop" onClick={closeQuickImport} />
          <div className="submodal-card batch-card">
            <div className="submodal-header">
              <h4>截图调仓</h4>
              <button className="mini-btn" onClick={closeQuickImport}>关闭</button>
            </div>
            <div className="submodal-body">
              <div className="batch-layout">
                <div className="batch-left">
                  <label className="form-item">
                    选择图片
                    <input type="file" accept="image/*" onChange={handleQuickFileChange} />
                  </label>
                  {quickImportPreview ? <img className="batch-preview" src={quickImportPreview} alt="交易记录预览" /> : null}
                  {quickImportLoading ? <div className="loading-indicator">识别中...</div> : null}
                </div>
                <div className="batch-right">
                  <div className="batch-head">识别结果</div>
                  <div className="batch-target">
                    <span>识别基金</span>
                    <input
                      type="text"
                      placeholder="识别基金（代码或名称）"
                      value={quickImportDetected}
                      onChange={(event) => {
                        const value = event.target.value.trim();
                        setQuickImportDetected(value);
                        if (quickImportSearchTimerRef.current) {
                          window.clearTimeout(quickImportSearchTimerRef.current);
                        }
                        if (!shouldLookupFund(value)) {
                          setQuickImportTarget('');
                          setQuickImportResolved(null);
                          return;
                        }
                        quickImportSearchTimerRef.current = window.setTimeout(() => {
                          lookupFundForQuickImport(value, true);
                        }, 300);
                      }}
                    />
                  </div>
                  <div className="batch-target">
                    <span>导入到</span>
                    <select
                      value={quickImportTarget}
                      onChange={(event) => setQuickImportTarget(event.target.value)}
                    >
                      <option value="">请选择基金</option>
                      {quickImportOptions.map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.name ? `${item.name} (${item.code})` : item.code}
                        </option>
                      ))}
                    </select>
                  </div>
                  {quickImportItems.length ? (
                    <div className="batch-list">
                      {quickImportItems.map((item) => {
                        const label = item.type === 'add' ? '加仓' : '减仓';
                        const edit = quickImportEdits[item.id] || { amount: '', shares: '' };
                        const showAmount = item.type === 'add' || item.amount !== null;
                        const showShares = item.type === 'reduce' || item.shares !== null;
                        const timeLabel = item.time ? ` ${item.time}` : '';
                        const timingLabel = item.timing === 'after' ? '15:00后' : '15:00前';
                        return (
                          <label key={item.id} className="batch-item">
                            <input
                              type="checkbox"
                              checked={Boolean(quickImportSelected[item.id])}
                              onChange={(e) =>
                                setQuickImportSelected((prev) => ({ ...prev, [item.id]: e.target.checked }))
                              }
                            />
                            <div className="batch-info">
                              <div className="batch-row">
                                <strong className={item.type === 'add' ? 'market-up' : 'market-down'}>{label}</strong>
                                <div className="batch-value">
                                  {showAmount ? (
                                    <div className="batch-input">
                                      <input
                                        type="number"
                                        inputMode="decimal"
                                        step="0.01"
                                        value={edit.amount}
                                        onChange={(e) => updateQuickValue(item.id, 'amount', e.target.value)}
                                      />
                                      <span className="batch-unit">元</span>
                                    </div>
                                  ) : null}
                                  {showShares ? (
                                    <div className="batch-input">
                                      <input
                                        type="number"
                                        inputMode="decimal"
                                        step="0.01"
                                        value={edit.shares}
                                        onChange={(e) => updateQuickValue(item.id, 'shares', e.target.value)}
                                      />
                                      <span className="batch-unit">份</span>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                              <span className="batch-meta">
                                {item.date}
                                {timeLabel} · {timingLabel}
                              </span>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="empty-state">暂无识别结果</div>
                  )}
                </div>
              </div>
              <div className="submodal-actions">
                <button className="btn secondary" type="button" onClick={closeQuickImport}>
                  取消
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={handleQuickImport}
                  disabled={!quickImportItems.length || !quickImportTarget}
                >
                  导入记录
                </button>
              </div>
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
