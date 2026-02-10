'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  ChartRange,
  BatchTradeInput,
  FundData,
  FundHistoryTableData,
  FundOperation,
  FundPerformance,
  FundPositionData,
  Holding,
  StockQuote,
  TradeTiming
} from '../../lib/types';
import { classByValue, formatMoney, formatMoneyWithSymbol, formatNumber, formatPct } from '../../lib/utils';
import { parseBatchText } from '../../lib/ocr';
import { computeHoldingView } from '../../lib/metrics';
import Chart from './Chart';

export default function FundModal({
  open,
  onClose,
  data,
  holding,
  inWatchlist,
  performance,
  performancePeriod,
  positions,
  historyTable,
  extrasLoading,
  historyPage,
  historyPages,
  onHistoryPageChange,
  operations,
  historyOpen,
  onHistoryOpenChange,
  holdingMethod,
  onMethodChange,
  form,
  costUnitText,
  onFormChange,
  onAddWatch,
  onRemove,
  removeLabel,
  onUpdateHolding,
  onEnsureFeeRate,
  onTradeAdd,
  onTradeReduce,
  onUndoOperation,
  onBatchImport,
  chartRange,
  onChartRangeChange,
  onPerformancePeriodChange
}: {
  open: boolean;
  onClose: () => void;
  data: FundData | null;
  holding: Holding | null;
  inWatchlist: boolean;
  performance: FundPerformance | null;
  performancePeriod: string;
  positions: FundPositionData | null;
  historyTable: FundHistoryTableData | null;
  extrasLoading: boolean;
  historyPage: number;
  historyPages: number;
  onHistoryPageChange: (page: number) => void;
  operations: FundOperation[];
  historyOpen: boolean;
  onHistoryOpenChange: (open: boolean) => void;
  holdingMethod: 'amount' | 'shares';
  onMethodChange: (method: 'amount' | 'shares') => void;
  form: {
    amount: string;
    profit: string;
    shares: string;
    costPrice: string;
    firstBuy: string;
  };
  costUnitText: string;
  onFormChange: (key: 'amount' | 'profit' | 'shares' | 'costPrice' | 'firstBuy', value: string) => void;
  onAddWatch: () => void;
  onRemove: () => void;
  removeLabel: string;
  onUpdateHolding: () => void;
  onEnsureFeeRate: () => void;
  onTradeAdd: (payload: { amount: string; feeRate: string; date: string; timing: TradeTiming }) => void;
  onTradeReduce: (payload: { shares: string; fee: string; date: string; timing: TradeTiming }) => void;
  onUndoOperation: (operationId: string) => void;
  onBatchImport: (items: BatchTradeInput[]) => void;
  chartRange: ChartRange;
  onChartRangeChange: (range: ChartRange) => void;
  onPerformancePeriodChange: (period: string) => void;
}) {
  const estClass = data?.estPct !== null && data?.estPct !== undefined ? classByValue(data.estPct) : '';
  const growthClass = performance && performance.growthPct !== null ? classByValue(performance.growthPct) : '';
  const rankChangeClass =
    performance?.rankChange?.direction === 'up'
      ? 'market-up'
      : performance?.rankChange?.direction === 'down'
        ? 'market-down'
        : 'market-flat';
  const quartileClass = performance?.quartile
    ? /优秀|良好/.test(performance.quartile)
      ? 'market-up'
      : /不佳/.test(performance.quartile)
        ? 'market-down'
        : 'market-flat'
    : '';
  const positionMeta = positions?.content ? extractPositionMeta(positions.content, positions.currentYear) : null;
  const positionDate = positions?.date || positionMeta?.date || '';
  const positionTitle = positions?.date
    ? toQuarterTitle(positions.date)
    : positionMeta?.title || '';
  const positionRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [tradeOpen, setTradeOpen] = useState<'add' | 'reduce' | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchImage, setBatchImage] = useState<File | null>(null);
  const [batchPreview, setBatchPreview] = useState('');
  const [ocrText, setOcrText] = useState('');
  const [ocrLoading, setOcrLoading] = useState(false);
  const [batchItems, setBatchItems] = useState<BatchTradeInput[]>([]);
  const [batchSelected, setBatchSelected] = useState<Record<string, boolean>>({});
  const [batchEdits, setBatchEdits] = useState<Record<string, { amount: string; shares: string }>>({});
  const [buyForm, setBuyForm] = useState({
    amount: '',
    feeRate: '',
    date: '',
    timing: 'before'
  });
  const [sellForm, setSellForm] = useState({
    shares: '',
    fee: '',
    date: '',
    timing: 'before'
  });
  const positionsHtml = useMemo(
    () => (positions?.content ? extractLatestPositionTable(positions.content) : ''),
    [positions?.content]
  );
  const positionsMarkup = useMemo(() => ({ __html: positionsHtml }), [positionsHtml]);
  const holdingsList = positions?.holdings || [];
  const historyRows = useMemo(() => {
    if (!historyTable?.content) return '';
    const tableMatch = historyTable.content.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
    const tableHtml = tableMatch ? tableMatch[1] : historyTable.content;
    const bodyMatch = tableHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
    if (bodyMatch) return bodyMatch[1];
    return tableHtml.replace(/<thead[\s\S]*?<\/thead>/i, '');
  }, [historyTable?.content]);
  const coloredHistoryRows = useMemo(() => {
    if (!historyRows) return '';
    if (typeof window === 'undefined') return historyRows;
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(`<table><tbody>${historyRows}</tbody></table>`, 'text/html');
      const rows = doc.querySelectorAll('tbody tr');
      rows.forEach((row) => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 4) return;
        const cell = cells[3];
        const raw = cell.textContent ? cell.textContent.trim() : '';
        const value = Number(raw.replace('%', ''));
        if (Number.isNaN(value)) return;
        if (value > 0) cell.classList.add('market-up');
        else if (value < 0) cell.classList.add('market-down');
        else cell.classList.add('market-flat');
      });
      const tbody = doc.querySelector('tbody');
      return tbody ? tbody.innerHTML : historyRows;
    } catch {
      return historyRows;
    }
  }, [historyRows]);
  const performancePeriods = [
    { key: 'ytd', label: '今年来' },
    { key: '1w', label: '近1周' },
    { key: '1m', label: '近1月' },
    { key: '3m', label: '近3月' },
    { key: '6m', label: '近6月' },
    { key: '1y', label: '近1年' },
    { key: '3y', label: '近3年' },
    { key: '5y', label: '近5年' },
    { key: 'since', label: '成立来' }
  ];

  const holdingShares = useMemo(() => {
    if (holding?.shares !== null && holding?.shares !== undefined) return holding.shares;
    if (holding?.amount !== null && holding?.amount !== undefined && data?.latestNav) {
      return holding.amount / data.latestNav;
    }
    return null;
  }, [holding, data?.latestNav]);

  const holdingView = useMemo(() => {
    if (!holding) return null;
    return computeHoldingView(holding, data);
  }, [holding, data]);

  const dailyPct = useMemo(() => {
    if (!data) return null;
    if (typeof data.estPct === 'number' && !Number.isNaN(data.estPct)) return data.estPct;
    const history = data.history;
    if (!Array.isArray(history) || history.length < 2) return null;
    const last = history[history.length - 1]?.nav ?? null;
    const prev = history[history.length - 2]?.nav ?? null;
    if (!last || !prev) return null;
    return ((last / prev) - 1) * 100;
  }, [data]);

  const dailyProfit =
    holdingView?.amount !== null && holdingView?.amount !== undefined && dailyPct !== null
      ? (holdingView.amount * dailyPct) / 100
      : null;
  const profitValue = holdingView?.profit ?? null;
  const holdingRate =
    holdingView?.amount !== null &&
    holdingView?.amount !== undefined &&
    profitValue !== null &&
    profitValue !== undefined &&
    holdingView.amount - profitValue !== 0
      ? (profitValue / (holdingView.amount - profitValue)) * 100
      : null;
  const dailyClass = classByValue(dailyProfit);
  const profitClass = classByValue(profitValue);
  const dailyRateClass = classByValue(dailyPct ?? null);
  const holdingRateClass = classByValue(holdingRate);

  const estimatedBuyFee = useMemo(() => {
    const amount = Number(buyForm.amount);
    const rate = Number(buyForm.feeRate);
    if (!Number.isFinite(amount) || !Number.isFinite(rate)) return '';
    return (amount * (rate / 100)).toFixed(2);
  }, [buyForm.amount, buyForm.feeRate]);

  useEffect(() => {
    if (!open) return;
    setBuyForm((prev) => ({
      ...prev,
      amount: '',
      feeRate: '',
      date: '',
      timing: 'before'
    }));
    setSellForm({ shares: '', fee: '', date: '', timing: 'before' });
  }, [open, data?.code]);

  useEffect(() => {
    if (!open) return;
    if (data?.feeRate === null || data?.feeRate === undefined) return;
    setBuyForm((prev) => {
      if (prev.feeRate) return prev;
      return { ...prev, feeRate: data.feeRate!.toFixed(2) };
    });
  }, [data?.feeRate, open, tradeOpen]);

  useEffect(() => {
    if (!batchOpen) return;
    setBatchItems([]);
    setBatchSelected({});
    setBatchEdits({});
    setOcrText('');
    setBatchImage(null);
    setBatchPreview('');
    setOcrLoading(false);
  }, [batchOpen]);

  const handleBatchFileChange = (event: any) => {
    const file = event.target.files?.[0] || null;
    setBatchImage(file);
    if (!file) {
      setBatchPreview('');
      setBatchItems([]);
      setBatchSelected({});
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setBatchPreview(String(reader.result || ''));
    };
    reader.readAsDataURL(file);
    handleOcr(file);
  };

  const handleBatchImport = () => {
    const selectedItems = batchItems.filter((item) => batchSelected[item.id]);
    if (!selectedItems.length) return;
    onBatchImport(selectedItems);
    setBatchOpen(false);
    setOcrText('');
    setBatchImage(null);
    setBatchPreview('');
    setBatchItems([]);
    setBatchSelected({});
  };

  const handleOcr = async (file: File) => {
    setOcrLoading(true);
    try {
      const Tesseract = await import('tesseract.js');
      const result = await Tesseract.recognize(file, 'chi_sim');
      const text = result?.data?.text || '';
      setOcrText(text);
      const items = parseBatchText(text);
      setBatchItems(items);
      const edits: Record<string, { amount: string; shares: string }> = {};
      items.forEach((item) => {
        edits[item.id] = {
          amount: item.amount !== null && item.amount !== undefined ? String(item.amount) : '',
          shares: item.shares !== null && item.shares !== undefined ? String(item.shares) : ''
        };
      });
      setBatchEdits(edits);
      const selected: Record<string, boolean> = {};
      items.forEach((item) => {
        selected[item.id] = true;
      });
      setBatchSelected(selected);
    } catch {
      setOcrText('');
      setBatchItems([]);
      setBatchSelected({});
    } finally {
      setOcrLoading(false);
    }
  };

  const parseNumericInput = (value: string) => {
    const cleaned = value.replace(/,/g, '').trim();
    if (!cleaned) return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  };

  const updateBatchValue = (id: string, field: 'amount' | 'shares', value: string) => {
    setBatchEdits((prev) => ({
      ...prev,
      [id]: { amount: prev[id]?.amount ?? '', shares: prev[id]?.shares ?? '', [field]: value }
    }));
    const parsed = parseNumericInput(value);
    setBatchItems((prev) => prev.map((item) => (item.id === id ? { ...item, [field]: parsed } : item)));
  };

  const operationTitle = (op: FundOperation) => {
    if (op.type === 'add') return '加仓';
    if (op.type === 'reduce') return '减仓';
    return '持仓修改';
  };

  const operationTitleClass = (op: FundOperation) =>
    op.type === 'add' ? 'op-add' : op.type === 'reduce' ? 'op-reduce' : '';

  const operationMeta = (op: FundOperation) => {
    const parts: { text: string; className?: string }[] = [];
      if (op.type === 'add' || op.type === 'reduce') {
        if (op.amount !== null && op.amount !== undefined) {
          const amountText = `${formatNumber(op.amount, 2)}元`;
          parts.push({
            text: amountText,
            className: `op-amount ${op.type === 'add' ? 'op-add' : op.type === 'reduce' ? 'op-reduce' : ''}`.trim()
          });
        }
        if (op.shares !== null && op.shares !== undefined) {
          parts.push({ text: `${formatNumber(op.shares, 2)}份` });
        }
        const derivedNav =
          op.amount !== null &&
          op.amount !== undefined &&
          op.shares !== null &&
          op.shares !== undefined &&
          op.shares !== 0
            ? op.amount / op.shares
            : null;
        const navToShow = op.nav ?? derivedNav;
        if (navToShow !== null && navToShow !== undefined) {
          parts.push({ text: `净值 ${formatNumber(navToShow, 4)}` });
        }
      const feeValue =
        op.fee !== null && op.fee !== undefined
          ? op.fee
          : op.feeRate !== null && op.feeRate !== undefined && op.amount !== null && op.amount !== undefined
            ? (op.amount * op.feeRate) / 100
            : null;
      if (feeValue !== null && feeValue !== undefined) {
        parts.push({ text: `手续费 ${formatNumber(feeValue, 2)}元` });
      }
    } else if (op.type === 'edit') {
      const prevAmount = op.prev?.amount ?? null;
      const nextAmount = op.next?.amount ?? null;
      if (prevAmount !== null && nextAmount !== null) {
        parts.push({
          text: `持有金额 ${formatMoneyWithSymbol(prevAmount)} → ${formatMoneyWithSymbol(nextAmount)}`,
          className: 'op-amount'
        });
      } else if (nextAmount !== null) {
        parts.push({
          text: `持有金额 ${formatMoneyWithSymbol(nextAmount)}`,
          className: 'op-amount'
        });
      }
    }
    if (op.date) {
      const timingLabel = op.timing ? (op.timing === 'before' ? '15:00前' : '15:00后') : '';
      parts.push({ text: `${op.date}${timingLabel ? ` ${timingLabel}` : ''}` });
    }
    return parts;
  };

  const chartMarkers = useMemo(
    () =>
      operations
        .filter((op) => (op.type === 'add' || op.type === 'reduce') && Boolean(op.date))
        .map((op) => ({ date: op.date || '', type: op.type })),
    [operations]
  );

  useLayoutEffect(() => {
    if (!open) return;
    if (!positionsHtml || !positions?.quotes || holdingsList.length) return;
    if (!positionRef.current) return;
    enhancePositionTable(positionRef.current, positions.quotes);
  }, [open, positionsHtml, positions?.quotes, holdingsList.length]);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (!moreRef.current) return;
      if (moreRef.current.contains(event.target as Node)) return;
      setMoreOpen(false);
    }
    if (moreOpen) document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [moreOpen]);

  if (!open) return null;

  return (
    <div className="modal show" id="fund-modal" aria-hidden={!open}>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-card">
        <div className="modal-header">
          <div>
            <h3 id="modal-title">{data?.name || '基金详情'}</h3>
            <div className="subtitle" id="modal-subtitle">{data?.code || '-'}</div>
          </div>
          <button className="mini-btn" id="modal-close" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-column modal-main">
            <div className="panel chart-panel">
            <h4>基金状态</h4>
            {data ? (
              <>
                <div className="fund-meta" id="modal-meta">
                  <div className="meta-block">
                    <span>最新净值</span>
                    <strong>{formatNumber(data.latestNav)}</strong>
                  </div>
                  <div className="meta-block">
                    <span>净值日期</span>
                    <strong>{data.latestDate || '-'}</strong>
                  </div>
                  <div className="meta-block">
                    <span>估值变动（参考）</span>
                    <strong className={estClass}>{data.estPct !== null ? formatPct(data.estPct) : '--'}</strong>
                  </div>
                  <div className="meta-block">
                    <span>更新时点</span>
                    <strong>{data.updateTime || '-'}</strong>
                  </div>
                </div>
                {holding ? (
                  <div className="holding-layout modal-holding">
                    <div className="holding-left">
                      <span>持有金额</span>
                      <strong>{formatMoneyWithSymbol(holdingView?.amount ?? null)}</strong>
                      <div className="holding-sub-row">
                        <em className="holding-sub">
                          持有份额 {holdingShares !== null && holdingShares !== undefined ? formatNumber(holdingShares, 2) : '--'}
                        </em>
                        <em className="holding-sub">
                          持仓成本价 {holdingView?.costUnit !== null && holdingView?.costUnit !== undefined ? formatNumber(holdingView.costUnit, 4) : '--'}
                        </em>
                      </div>
                    </div>
                    <div className="holding-right">
                      <div className="holding-row">
                        <div className="holding-main">
                          <span>当日收益</span>
                          <strong className={dailyClass}>
                            {dailyProfit === null ? '--' : formatMoney(dailyProfit)}
                          </strong>
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
                ) : (
                  <div className="holding-layout modal-holding holding-empty">
                    <div className="holding-empty-card">
                      <span>暂无持仓数据</span>
                      <em>添加持仓后展示持有金额与收益</em>
                    </div>
                  </div>
                )}
                <div className="time-toggle metrics-toggle" id="metric-range">
                  {performancePeriods.map((item) => (
                    <button
                      key={item.key}
                      className={`mini-btn ${performancePeriod === item.key ? 'active' : ''}`}
                      type="button"
                      onClick={() => onPerformancePeriodChange(item.key)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="fund-metrics" id="modal-metrics">
                  <div className="metric">
                    <span>涨幅</span>
                    <strong className={growthClass}>{formatPct(performance?.growthPct ?? null)}</strong>
                  </div>
                  <div className="metric">
                    <span>同类排名</span>
                    <strong>{performance?.rank || '--'}</strong>
                  </div>
                  <div className="metric">
                    <span>排名变动</span>
                    <strong className={rankChangeClass}>
                      {performance?.rankChange?.value !== null && performance?.rankChange?.value !== undefined
                        ? `${performance.rankChange.value}${performance.rankChange.direction === 'up' ? '↑' : performance.rankChange.direction === 'down' ? '↓' : ''}`
                        : '--'}
                    </strong>
                  </div>
                  <div className="metric">
                    <span>四分位排名</span>
                    <strong className={quartileClass}>{performance?.quartile || '--'}</strong>
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-state">正在拉取数据...</div>
            )}
            <div className="modal-actions">
              <div className="position-actions">
                <div className="action-left">
                  <button className="btn" type="button" onClick={() => setEditOpen(true)}>
                    修改持仓
                  </button>
                  <button className="btn secondary" type="button" onClick={() => setBatchOpen(true)}>
                    批量调仓
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => {
                      onEnsureFeeRate();
                      setTradeOpen('add');
                    }}
                  >
                    加仓
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => setTradeOpen('reduce')}
                    disabled={!holdingShares}
                  >
                    减仓
                  </button>
                </div>
                <div className="action-right" ref={moreRef}>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => onHistoryOpenChange(true)}
                  >
                    历史
                  </button>
                  <button
                    className="btn secondary more-btn"
                    type="button"
                    onClick={() => setMoreOpen((prev) => !prev)}
                  >
                    更多
                  </button>
                  {moreOpen && (
                    <div className="more-menu">
                      <button
                        type="button"
                        className="more-item"
                        onClick={() => {
                          onAddWatch();
                          setMoreOpen(false);
                        }}
                        disabled={inWatchlist}
                      >
                        {inWatchlist ? '已在自选' : '添加自选'}
                      </button>
                      {(holding || inWatchlist) && (
                        <button
                          type="button"
                          className="more-item danger"
                          onClick={() => {
                            onRemove();
                            setMoreOpen(false);
                          }}
                        >
                          {removeLabel}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="helper" id="modal-hint"></div>
            </div>
            <div className="panel">
              <div className="detail-header">
                <h4>净值走势</h4>
                <div className="time-toggle" id="chart-range">
                  <button
                    className={`mini-btn ${chartRange === '1y' ? 'active' : ''}`}
                    data-range="1y"
                    onClick={() => onChartRangeChange('1y')}
                  >
                    一年
                  </button>
                  <button
                    className={`mini-btn ${chartRange === '6m' ? 'active' : ''}`}
                    data-range="6m"
                    onClick={() => onChartRangeChange('6m')}
                  >
                    半年
                  </button>
                  <button
                    className={`mini-btn ${chartRange === '1m' ? 'active' : ''}`}
                    data-range="1m"
                    onClick={() => onChartRangeChange('1m')}
                  >
                    一个月
                  </button>
                </div>
              </div>
              <Chart history={data?.history || []} range={chartRange} markers={chartMarkers} />
              <div className="helper panel-footer" id="modal-note">
                {data?.updateTime ? `数据更新：${data.updateTime} · 仅供参考` : '数据更新中'}
              </div>
            </div>
          </div>
          <div className="modal-column modal-side">
            <div className="panel history-panel">
              <div className="detail-header">
                <h4>基金持仓</h4>
                {positionTitle ? <span className="detail-link">{positionTitle}</span> : null}
              </div>
              {positionDate ? (
                <div className="detail-note">
                  截止至：{positionDate}
                  {positions?.source ? ` · 来源：${positions.source}` : ''}
                </div>
              ) : null}
              {holdingsList.length ? (
                <div className="raw-html raw-html--positions">
                  <table className="positions-table">
                    <thead>
                      <tr>
                        <th>股票代码</th>
                        <th>股票名称</th>
                        <th>涨跌幅</th>
                        <th>占净值比例</th>
                        <th>变动</th>
                      </tr>
                    </thead>
                    <tbody>
                      {holdingsList.map((item) => {
                        const quoteKey = (
                          item.code ||
                          (item.secid ? item.secid.split('.').pop() : '') ||
                          ''
                        ).toUpperCase();
                        const quote = quoteKey ? positions?.quotes?.[quoteKey] : undefined;
                        const pct = quote?.pct ?? null;
                        const displayCode =
                          item.code ||
                          (item.secid ? item.secid.split('.').pop() : '') ||
                          quote?.code ||
                          '--';
                        return (
                          <tr key={`${item.code}-${item.name}`}>
                            <td>{displayCode}</td>
                            <td>{item.name || '--'}</td>
                            <td className={pct === null ? '' : pct > 0 ? 'market-up' : pct < 0 ? 'market-down' : 'market-flat'}>
                              {pct === null ? '--' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}
                            </td>
                            <td>{item.weight !== null && item.weight !== undefined ? `${item.weight.toFixed(2)}%` : '--'}</td>
                            <td
                              className={
                                item.change === null || item.change === undefined
                                  ? ''
                                  : item.change > 0
                                    ? 'market-up'
                                    : item.change < 0
                                      ? 'market-down'
                                      : 'market-flat'
                              }
                            >
                              {item.changeType === '新增'
                                ? '新增'
                                : item.change !== null && item.change !== undefined
                                  ? `${item.change > 0 ? '+' : ''}${item.change.toFixed(2)}%`
                                  : '--'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : positionsHtml ? (
                <div
                  className="raw-html raw-html--positions"
                  ref={positionRef}
                  dangerouslySetInnerHTML={positionsMarkup}
                />
              ) : (
                <div className="empty-state">{extrasLoading ? '正在拉取数据...' : '暂无持仓数据'}</div>
              )}
            </div>
          <div className="panel">
            <div className="detail-header">
              <h4>历史净值</h4>
              <div className="history-controls">
                <button
                  className="icon-btn"
                  type="button"
                  aria-label="上一页"
                  disabled={historyPage <= 1}
                  onClick={() => onHistoryPageChange(Math.max(1, historyPage - 1))}
                >
                  ◀
                </button>
                <span className="badge">
                  第 {historyTable?.currentPage || historyPage} / {historyPages} 页
                </span>
                <button
                  className="icon-btn"
                  type="button"
                  aria-label="下一页"
                  disabled={historyPage >= historyPages}
                  onClick={() => onHistoryPageChange(Math.min(historyPages, historyPage + 1))}
                >
                  ▶
                </button>
              </div>
            </div>
            {historyTable?.content ? (
              <div className="history-table-wrap">
                <div className="history-table-head">
                  <table className="history-table">
                    <colgroup>
                      <col style={{ width: '16%' }} />
                      <col style={{ width: '14%' }} />
                      <col style={{ width: '14%' }} />
                      <col style={{ width: '12%' }} />
                      <col style={{ width: '16%' }} />
                      <col style={{ width: '14%' }} />
                      <col style={{ width: '14%' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>净值日期</th>
                        <th>单位净值</th>
                        <th>累计净值</th>
                      <th>日涨跌</th>
                        <th>申购状态</th>
                        <th>赎回状态</th>
                        <th>分红送配</th>
                      </tr>
                    </thead>
                  </table>
                </div>
                <div className="raw-html raw-html--history">
                  <table className="history-table">
                    <colgroup>
                      <col style={{ width: '16%' }} />
                      <col style={{ width: '14%' }} />
                      <col style={{ width: '14%' }} />
                      <col style={{ width: '12%' }} />
                      <col style={{ width: '16%' }} />
                      <col style={{ width: '14%' }} />
                      <col style={{ width: '14%' }} />
                    </colgroup>
                    <tbody dangerouslySetInnerHTML={{ __html: coloredHistoryRows }} />
                  </table>
                </div>
              </div>
            ) : (
              <div className="empty-state">{extrasLoading ? '正在拉取数据...' : '暂无历史净值数据'}</div>
            )}
          </div>
          </div>
        </div>
      </div>
      {tradeOpen && (
        <div className="submodal">
          <div className="submodal-backdrop" onClick={() => setTradeOpen(null)} />
          <div className="submodal-card">
            <div className="submodal-header">
              <h4>{tradeOpen === 'add' ? '加仓' : '减仓'}</h4>
              <button className="mini-btn" onClick={() => setTradeOpen(null)}>关闭</button>
            </div>
            {tradeOpen === 'add' ? (
              <div className="submodal-body">
                <label className="form-item">
                  加仓金额
                  <input
                    type="number"
                    step="0.01"
                    value={buyForm.amount}
                    onChange={(e) => setBuyForm((prev) => ({ ...prev, amount: e.target.value }))}
                  />
                </label>
                <label className="form-item">
                  买入费率（%）
                  <input
                    type="number"
                    step="0.01"
                    value={buyForm.feeRate}
                    onChange={(e) => setBuyForm((prev) => ({ ...prev, feeRate: e.target.value }))}
                  />
                </label>
                <label className="form-item">
                  估算手续费
                  <input type="text" readOnly value={estimatedBuyFee ? `¥${estimatedBuyFee}` : '--'} />
                </label>
                <label className="form-item">
                  买入日期
                  <input
                    type="date"
                    value={buyForm.date}
                    onChange={(e) => setBuyForm((prev) => ({ ...prev, date: e.target.value }))}
                  />
                </label>
                <div className="time-toggle">
                  <button
                    className={`mini-btn ${buyForm.timing === 'before' ? 'active' : ''}`}
                    type="button"
                    onClick={() => setBuyForm((prev) => ({ ...prev, timing: 'before' }))}
                  >
                    15:00 前
                  </button>
                  <button
                    className={`mini-btn ${buyForm.timing === 'after' ? 'active' : ''}`}
                    type="button"
                    onClick={() => setBuyForm((prev) => ({ ...prev, timing: 'after' }))}
                  >
                    15:00 后
                  </button>
                </div>
                <div className="submodal-actions">
                  <button className="btn secondary" type="button" onClick={() => setTradeOpen(null)}>
                    取消
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      onTradeAdd({
                        amount: buyForm.amount,
                        feeRate: buyForm.feeRate,
                        date: buyForm.date,
                        timing: buyForm.timing as TradeTiming
                      });
                      setTradeOpen(null);
                      setBuyForm({
                        amount: '',
                        feeRate: data?.feeRate !== null && data?.feeRate !== undefined ? data.feeRate.toFixed(2) : '',
                        date: '',
                        timing: 'before'
                      });
                    }}
                  >
                    确认加仓
                  </button>
                </div>
              </div>
            ) : (
              <div className="submodal-body">
                <label className="form-item">
                  卖出份额
                  <input
                    type="number"
                    step="0.01"
                    value={sellForm.shares}
                    onChange={(e) => setSellForm((prev) => ({ ...prev, shares: e.target.value }))}
                  />
                </label>
                <div className="quick-row">
                  {[
                    { label: '1/4', value: 0.25 },
                    { label: '1/3', value: 1 / 3 },
                    { label: '1/2', value: 0.5 },
                    { label: '全部', value: 1 }
                  ].map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      className="chip-btn"
                      disabled={!holdingShares}
                      onClick={() => {
                        if (!holdingShares) return;
                        const amount = holdingShares * item.value;
                        setSellForm((prev) => ({ ...prev, shares: amount.toFixed(2) }));
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <label className="form-item">
                  卖出手续费
                  <input
                    type="number"
                    step="0.01"
                    value={sellForm.fee}
                    onChange={(e) => setSellForm((prev) => ({ ...prev, fee: e.target.value }))}
                  />
                </label>
                <label className="form-item">
                  卖出日期
                  <input
                    type="date"
                    value={sellForm.date}
                    onChange={(e) => setSellForm((prev) => ({ ...prev, date: e.target.value }))}
                  />
                </label>
                <div className="time-toggle">
                  <button
                    className={`mini-btn ${sellForm.timing === 'before' ? 'active' : ''}`}
                    type="button"
                    onClick={() => setSellForm((prev) => ({ ...prev, timing: 'before' }))}
                  >
                    15:00 前
                  </button>
                  <button
                    className={`mini-btn ${sellForm.timing === 'after' ? 'active' : ''}`}
                    type="button"
                    onClick={() => setSellForm((prev) => ({ ...prev, timing: 'after' }))}
                  >
                    15:00 后
                  </button>
                </div>
                <div className="submodal-actions">
                  <button className="btn secondary" type="button" onClick={() => setTradeOpen(null)}>
                    取消
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      onTradeReduce({
                        shares: sellForm.shares,
                        fee: sellForm.fee,
                        date: sellForm.date,
                        timing: sellForm.timing as TradeTiming
                      });
                      setTradeOpen(null);
                      setSellForm({ shares: '', fee: '', date: '', timing: 'before' });
                    }}
                  >
                    确认减仓
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {editOpen && (
        <div className="submodal">
          <div className="submodal-backdrop" onClick={() => setEditOpen(false)} />
          <div className="submodal-card">
            <div className="submodal-header">
              <h4>修改持仓</h4>
              <button className="mini-btn" onClick={() => setEditOpen(false)}>关闭</button>
            </div>
            <div className="submodal-body">
              <div className="method-toggle" id="holding-method">
                <button
                  className={`mini-btn ${holdingMethod === 'amount' ? 'active' : ''}`}
                  data-method="amount"
                  onClick={() => onMethodChange('amount')}
                >
                  按金额
                </button>
                <button
                  className={`mini-btn ${holdingMethod === 'shares' ? 'active' : ''}`}
                  data-method="shares"
                  onClick={() => onMethodChange('shares')}
                >
                  按份额
                </button>
              </div>
              <div className="modal-form" data-mode={holdingMethod}>
                <label className="form-item" data-method="amount">
                  持有金额
                  <input
                    id="modal-amount"
                    type="number"
                    step="0.01"
                    placeholder="例如 20000"
                    value={form.amount}
                    onChange={(e) => onFormChange('amount', e.target.value)}
                  />
                </label>
                <label className="form-item" data-method="amount">
                  持有收益
                  <input
                    id="modal-profit"
                    type="number"
                    step="0.01"
                    placeholder="例如 1200"
                    value={form.profit}
                    onChange={(e) => onFormChange('profit', e.target.value)}
                  />
                </label>
                <label className="form-item" data-method="shares">
                  持有份额
                  <input
                    id="modal-shares"
                    type="number"
                    step="0.01"
                    placeholder="例如 3200"
                    value={form.shares}
                    onChange={(e) => onFormChange('shares', e.target.value)}
                  />
                </label>
                <label className="form-item" data-method="shares">
                  持仓成本价
                  <input
                    id="modal-cost-price"
                    type="number"
                    step="0.0001"
                    placeholder="例如 1.2568"
                    value={form.costPrice}
                    onChange={(e) => onFormChange('costPrice', e.target.value)}
                  />
                </label>
                <label className="form-item">
                  第一次购买日期
                  <input
                    id="modal-firstbuy"
                    type="date"
                    value={form.firstBuy}
                    onChange={(e) => onFormChange('firstBuy', e.target.value)}
                  />
                </label>
                <div className="form-item">
                  成本单价（自动计算）
                  <input id="modal-cost" type="text" readOnly value={costUnitText} />
                </div>
              </div>
              <div className="submodal-actions">
                <button className="btn secondary" type="button" onClick={() => setEditOpen(false)}>
                  取消
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    onUpdateHolding();
                    setEditOpen(false);
                  }}
                >
                  确认修改
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {batchOpen && (
        <div className="submodal">
          <div className="submodal-backdrop" onClick={() => setBatchOpen(false)} />
          <div className="submodal-card batch-card">
            <div className="submodal-header">
              <h4>批量调仓</h4>
            </div>
            <div className="submodal-body">
              <div className="batch-layout">
                <div className="batch-left">
                  <label className="form-item">
                    选择图片
                    <input type="file" accept="image/*" onChange={handleBatchFileChange} />
                  </label>
                  {batchPreview ? <img className="batch-preview" src={batchPreview} alt="交易记录预览" /> : null}
                  {ocrLoading ? <div className="loading-indicator">识别中...</div> : null}
                </div>
                <div className="batch-right">
                  <div className="batch-head">识别结果</div>
                  {batchItems.length ? (
                    <div className="batch-list">
                      {batchItems.map((item) => {
                        const label = item.type === 'add' ? '加仓' : '减仓';
                        const edit = batchEdits[item.id] || { amount: '', shares: '' };
                        const showAmount = item.type === 'add' || item.amount !== null;
                        const showShares = item.type === 'reduce' || item.shares !== null;
                        const timeLabel = item.time ? ` ${item.time}` : '';
                        const timingLabel = item.timing === 'after' ? '15:00后' : '15:00前';
                        return (
                          <label key={item.id} className="batch-item">
                            <input
                              type="checkbox"
                              checked={Boolean(batchSelected[item.id])}
                              onChange={(e) =>
                                setBatchSelected((prev) => ({ ...prev, [item.id]: e.target.checked }))
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
                                        onChange={(e) => updateBatchValue(item.id, 'amount', e.target.value)}
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
                                        onChange={(e) => updateBatchValue(item.id, 'shares', e.target.value)}
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
                <button className="btn secondary" type="button" onClick={() => setBatchOpen(false)}>
                  取消
                </button>
                <button className="btn" type="button" onClick={handleBatchImport} disabled={!batchItems.length}>
                  导入记录
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {historyOpen && (
        <div className="submodal">
          <div className="submodal-backdrop" onClick={() => onHistoryOpenChange(false)} />
          <div className="submodal-card history-card">
            <div className="submodal-header">
              <h4>历史操作记录</h4>
              <button className="mini-btn" onClick={() => onHistoryOpenChange(false)}>关闭</button>
            </div>
            <div className="submodal-body">
              {operations.length ? (
                <div className="history-list">
                  {operations.map((op) => {
                    const metaParts = operationMeta(op);
                    return (
                      <div key={op.id} className="history-item">
                        <div className="history-main">
                          <div className={`history-title ${operationTitleClass(op)}`}>{operationTitle(op)}</div>
                          <div className="history-meta">
                            {metaParts.length
                              ? metaParts.map((part, idx) => (
                                  <span key={`${op.id}-${idx}`}>
                                    <span className={part.className}>{part.text}</span>
                                    {idx < metaParts.length - 1 ? <span className="meta-dot"> · </span> : null}
                                  </span>
                                ))
                              : '—'}
                          </div>
                        </div>
                      <div className="history-actions">
                        {op.status === 'pending' && <span className="badge pending">交易确认中</span>}
                        <button className="mini-btn" type="button" onClick={() => onUndoOperation(op.id)}>
                          撤回
                        </button>
                      </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-state">暂无操作记录</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function extractPositionMeta(content: string, fallbackYear?: string) {
  if (!content) return null;
  const quarterMatch = content.match(/(\d{4})年(\d{1,2})季度[^<>]*投资明细/);
  const quarterIndex = content.search(/\d{4}年\d{1,2}季度/);
  const scanStart = quarterIndex >= 0 ? Math.max(0, quarterIndex - 80) : 0;
  const scanEnd = quarterIndex >= 0 ? Math.min(content.length, quarterIndex + 240) : Math.min(content.length, 240);
  const scan = content.slice(scanStart, scanEnd);

  const explicitDateMatch =
    content.match(/截止至[:：\s]*<[^>]*>\s*((\d{4})[./-](\d{1,2})[./-](\d{1,2}))/i) ||
    content.match(/截止至[:：\s]*((\d{4})[./-](\d{1,2})[./-](\d{1,2}))/i);

  const dateMatch =
    explicitDateMatch ||
    scan.match(/(?:截至|截止)(?:日期)?[:：\s]*((\d{4})[./-](\d{1,2})[./-](\d{1,2}))/) ||
    scan.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  let date = '';
  if (dateMatch) {
    const raw = (dateMatch[1] || dateMatch[0] || '').replace(/\./g, '-');
    const found = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (found) {
      const year = found[1];
      const month = found[2].padStart(2, '0');
      const day = found[3].padStart(2, '0');
      date = `${year}-${month}-${day}`;
    }
  }

  if (!date && fallbackYear && /^\d{4}$/.test(fallbackYear)) {
    date = `${fallbackYear}-12-31`;
  }

  let title = '';
  if (quarterMatch && quarterMatch[0]) {
    title = quarterMatch[0].replace(/\s+/g, ' ').trim();
  } else if (date) {
    const year = date.slice(0, 4);
    const month = Number(date.slice(5, 7));
    const quarter = Math.max(1, Math.min(4, Math.ceil(month / 3)));
    title = `${year}年${quarter}季度股票投资明细`;
  }

  const linkMatch =
    scan.match(/href=['\"]([^'\"]*ccmx_\d{6}[^'\"]*)['\"]/i) ||
    content.match(/href=['\"]([^'\"]*ccmx_\d{6}[^'\"]*)['\"]/i);
  const link = linkMatch ? linkMatch[1] : '';

  return { date, title, link };
}

function extractLatestPositionTable(content: string) {
  if (!content) return '';
  const match = content.match(/<table[\s\S]*?<\/table>/i);
  return match ? match[0] : content;
}

function toQuarterTitle(date: string) {
  if (!date) return '';
  const match = date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return '';
  const year = match[1];
  const month = Number(match[2]);
  if (!month) return '';
  const quarter = Math.max(1, Math.min(4, Math.ceil(month / 3)));
  return `${year}年${quarter}季度股票投资明细`;
}

function enhancePositionTable(root: HTMLDivElement, quotes: Record<string, StockQuote>) {
  const firstTable = root.querySelector('table');
  if (!firstTable) return;
  if (firstTable.getAttribute('data-enhanced') === 'true') return;

  const cloned = firstTable.cloneNode(true) as HTMLTableElement;
  root.innerHTML = '';
  root.appendChild(cloned);

  const table = root.querySelector('table');
  if (!table) return;

  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return;
  const hasQuotes = Boolean(quotes && Object.keys(quotes).length);

  rows.forEach((row) => {
    const links = Array.from(row.querySelectorAll('a'));
    links.forEach((link) => {
      if ((link.textContent || '').includes('股吧')) {
        link.remove();
      }
    });

    const infoLinks = Array.from(row.querySelectorAll('td a')).filter((link) => {
      const text = (link.textContent || '').trim();
      return text === '变动详情' || text === '行情';
    });
    if (infoLinks.length >= 2) {
      const divider = document.createElement('span');
      divider.textContent = ' | ';
      infoLinks[0].after(divider);
    }
  });

  const headerRow =
    rows.find((row) => (row.textContent || '').includes('股票代码')) || rows[0];
  if (!headerRow) return;

  const headerFirstCell = headerRow.children[0] as HTMLElement | undefined;
  const shouldRemoveIndex = headerFirstCell
    ? (headerFirstCell.textContent || '').replace(/\s+/g, '').includes('序号')
    : false;

  if (shouldRemoveIndex) {
    rows.forEach((row) => {
      const firstCell = row.children[0];
      if (firstCell) {
        row.removeChild(firstCell);
      }
    });
  }

  const headerCells = Array.from(headerRow.children);
  const removeIndexes: number[] = [];
  headerCells.forEach((cell, idx) => {
    const text = (cell.textContent || '').replace(/\s+/g, '');
    if (text.includes('最新价') || (hasQuotes && text.includes('涨跌幅'))) {
      removeIndexes.push(idx);
    }
  });

  removeIndexes.sort((a, b) => b - a);
  if (removeIndexes.length) {
    rows.forEach((row) => {
      removeIndexes.forEach((idx) => {
        const cell = row.children[idx];
        if (cell) row.removeChild(cell);
      });
    });
  }

  if (hasQuotes) {
    const pctTh = document.createElement('th');
    pctTh.textContent = '涨跌幅';
    pctTh.setAttribute('data-quote', 'pct');
    headerRow.appendChild(pctTh);

    rows.slice(1).forEach((row) => {
      const code = extractCodeFromRow(row);
      if (!code) return;
      const quote = quotes[code] || null;
      const pctCell = document.createElement('td');
      pctCell.setAttribute('data-quote', 'pct');
      row.appendChild(pctCell);

      if (quote?.pct !== null && quote?.pct !== undefined) {
        pctCell.textContent = `${quote.pct > 0 ? '+' : ''}${quote.pct.toFixed(2)}%`;
        pctCell.className = quote.pct > 0 ? 'market-up' : quote.pct < 0 ? 'market-down' : 'market-flat';
      } else {
        pctCell.textContent = '--';
        pctCell.className = '';
      }
    });
  }

  table.setAttribute('data-enhanced', 'true');
}

function extractCodeFromRow(row: Element) {
  const firstCell = row.querySelector('td');
  if (firstCell) {
    const text = firstCell.textContent || '';
    const matches = text.match(/\d{6}/g);
    if (matches && matches.length) return matches[matches.length - 1];
    const ticker = text.trim().toUpperCase();
    if (/^[A-Z]{1,6}$/.test(ticker)) return ticker;
  }
  const html = row.innerHTML;
  const match = html.match(/ccmx_(\d{6})/);
  if (match && match[1]) return match[1];
  const secidTicker = html.match(/unify\/r\/[0-9]+\.(\w+)/i);
  if (secidTicker && secidTicker[1]) return secidTicker[1].toUpperCase();
  const unifyMatch = html.match(/unify\/r\/(?:\d\.)?(\d{6})/i);
  if (unifyMatch && unifyMatch[1]) return unifyMatch[1];
  const text = row.textContent || '';
  const loose = text.match(/\d{6}/g);
  return loose && loose.length ? loose[loose.length - 1] : '';
}
