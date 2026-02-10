export type SearchItem = {
  code: string;
  abbr: string;
  name: string;
  type: string;
  pinyin: string;
};

export type FundSummary = {
  code: string;
  name: string;
  type?: string;
  latestNav: number | null;
  latestDate: string;
  estNav: number | null;
  estPct: number | null;
  updateTime: string;
};

export type FundHistoryPoint = {
  date: string;
  nav: number;
  accumulated_value?: number;
  daily_growth_rate?: number;
};

export type FundPositionData = {
  content: string;
  years: string[];
  currentYear: string;
  quotes?: Record<string, StockQuote>;
  holdings?: FundPositionItem[];
  date?: string;
  source?: string;
};

export type FundPositionItem = {
  code: string;
  name: string;
  market?: string;
  weight?: number | null;
  change?: number | null;
  changeType?: string;
  secid?: string;
};

export type FundHistoryTableData = {
  content: string;
  pages: number | null;
  currentPage: number | null;
  totalRecords: number | null;
};

export type FundPerformance = {
  period: string;
  growthPct: number | null;
  rank: string;
  rankChange: {
    value: number | null;
    direction: 'up' | 'down' | 'flat';
  };
  quartile: string;
};

export type StockQuote = {
  code: string;
  name?: string;
  price: number | null;
  pct: number | null;
};

export type FundMetrics = {
  cumulative: number;
  recent: number;
  oneYear: number;
  maxDrawdown: number;
  volatility: number;
};

export type FundData = {
  code: string;
  name: string;
  history: FundHistoryPoint[];
  metrics: FundMetrics | null;
  latestNav: number | null;
  latestDate: string;
  estNav: number | null;
  estPct: number | null;
  updateTime: string;
  feeRate?: number | null;
};

export type Holding = {
  code: string;
  method: 'amount' | 'shares';
  amount: number | null;
  profit: number | null;
  shares: number | null;
  costPrice: number | null;
  firstBuy: string;
};

export type ChartRange = '1y' | '6m' | '1m';

export type ChartMarker = {
  date: string;
  type: 'add' | 'reduce';
};

export type TrendState = {
  label: string;
  cls: 'strong' | 'weak' | 'flat';
};

export type TradeTiming = 'before' | 'after';

export type FundOperation = {
  id: string;
  code: string;
  type: 'add' | 'reduce' | 'edit';
  status: 'pending' | 'confirmed';
  createdAt: number;
  applyAt: number;
  method?: 'amount' | 'shares';
  amount?: number | null;
  shares?: number | null;
  feeRate?: number | null;
  fee?: number | null;
  date?: string;
  timing?: TradeTiming;
  isQdii?: boolean;
  prev?: Holding | null;
  next?: Holding | null;
};
