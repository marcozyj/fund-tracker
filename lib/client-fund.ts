import type {
  FundHistoryPoint,
  FundHistoryTableData,
  FundPerformance,
  FundPositionData,
  SearchItem,
  StockQuote
} from './types';
import { normalizeCode, toNumber } from './utils';

declare global {
  interface Window {
    apidata?: any;
    jsonpgz?: (data: any) => void;
    Data_netWorthTrend?: any;
    fS_name?: string;
  }
}

const CN_TIMEZONE = 'Asia/Shanghai';
const cnFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CN_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const FUND_GZ_URL = 'https://fundgz.1234567.com.cn/js/';
const PINGZHONG_URL = 'https://fund.eastmoney.com/pingzhongdata/';
const FUND_HISTORY_TABLE_URL = 'https://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz';
const FUND_FEE_API_URL = 'https://fund.eastmoney.com/f10/F10DataApi.aspx?type=jjfl';
const FUND_JDZF_URL = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jdzf';
const FUND_POSITION_URL = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc';
const FUND_SEARCH_URL =
  'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=';
const STOCK_QUOTE_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get';
const STOCK_QUOTE_FIELDS = 'f12,f14,f2,f3';
const STOCK_QUOTE_TTL = 60 * 1000;
const stockQuoteCache = new Map<string, { data: StockQuote; fetchedAt: number }>();

function toDateString(value: any) {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = cnFormatter.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value || '';
  const month = parts.find((p) => p.type === 'month')?.value || '';
  const day = parts.find((p) => p.type === 'day')?.value || '';
  if (!year || !month || !day) return '';
  return `${year}-${month}-${day}`;
}

function loadScript(url: string, timeoutMs = 8000): Promise<void> {
  if (typeof document === 'undefined') return Promise.reject(new Error('No document'));
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Script load timeout'));
    }, timeoutMs);

    const cleanup = () => {
      window.clearTimeout(timer);
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    script.src = url;
    script.async = true;
    script.onload = () => {
      cleanup();
      resolve();
    };
    script.onerror = () => {
      cleanup();
      reject(new Error('Script load failed'));
    };
    document.body.appendChild(script);
  });
}

function loadJsonp(url: string, timeoutMs = 8000): Promise<any | null> {
  if (typeof document === 'undefined') return Promise.reject(new Error('No document'));
  return new Promise((resolve) => {
    const callbackName = `__fund_jsonp_${Math.random().toString(36).slice(2, 10)}`;
    const joiner = url.includes('?') ? '&' : '?';
    const script = document.createElement('script');
    const timer = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const cleanup = () => {
      window.clearTimeout(timer);
      if (script.parentNode) script.parentNode.removeChild(script);
      delete (window as any)[callbackName];
    };

    (window as any)[callbackName] = (data: any) => {
      cleanup();
      resolve(data);
    };

    script.src = `${url}${joiner}cb=${callbackName}`;
    script.async = true;
    script.onerror = () => {
      cleanup();
      resolve(null);
    };
    document.body.appendChild(script);
  });
}

function queueTask<T>(queue: Promise<unknown>, task: () => Promise<T>) {
  const next = queue.then(task, task);
  return { result: next, queue: next.then(() => undefined, () => undefined) };
}

let apidataQueue: Promise<unknown> = Promise.resolve();
async function loadApidata(url: string) {
  const { result, queue } = queueTask(apidataQueue, async () => {
    const prev = window.apidata;
    try {
      await loadScript(url);
      return window.apidata ?? null;
    } finally {
      if (prev === undefined) delete window.apidata;
      else window.apidata = prev;
    }
  });
  apidataQueue = queue;
  return result;
}

let pingzhongQueue: Promise<unknown> = Promise.resolve();
async function loadPingzhong(code: string) {
  const { result, queue } = queueTask(pingzhongQueue, async () => {
    const prevTrend = window.Data_netWorthTrend;
    const prevName = window.fS_name;
    try {
      await loadScript(`${PINGZHONG_URL}${code}.js?v=${Date.now()}`);
      return {
        history: window.Data_netWorthTrend || [],
        name: window.fS_name || ''
      };
    } finally {
      if (prevTrend === undefined) delete window.Data_netWorthTrend;
      else window.Data_netWorthTrend = prevTrend;
      if (prevName === undefined) delete window.fS_name;
      else window.fS_name = prevName;
    }
  });
  pingzhongQueue = queue;
  return result;
}

let jsonpgzQueue: Promise<unknown> = Promise.resolve();
async function loadJsonpgz(code: string) {
  const { result, queue } = queueTask(jsonpgzQueue, async () => {
    if (typeof document === 'undefined') return null;
    return new Promise<any>((resolve, reject) => {
      const prev = window.jsonpgz;
      const url = `${FUND_GZ_URL}${code}.js?rt=${Date.now()}`;
      const script = document.createElement('script');
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('jsonpgz timeout'));
      }, 8000);
      const cleanup = () => {
        window.clearTimeout(timer);
        if (script.parentNode) script.parentNode.removeChild(script);
        if (prev) window.jsonpgz = prev;
        else delete window.jsonpgz;
      };
      window.jsonpgz = (data: any) => {
        cleanup();
        resolve(data);
      };
      script.src = url;
      script.async = true;
      script.onerror = () => {
        cleanup();
        reject(new Error('jsonpgz load failed'));
      };
      document.body.appendChild(script);
    });
  });
  jsonpgzQueue = queue;
  return result;
}

function extractFeeRateFromContent(html: string): number | null {
  if (!html) return null;
  const matches = html.match(/(\d+(?:\.\d+)?)%/g) || [];
  const values = matches
    .map((item) => Number(item.replace('%', '')))
    .filter((value) => Number.isFinite(value));
  if (!values.length) {
    return /免|0元|0%/.test(html) ? 0 : null;
  }
  const positive = values.filter((value) => value > 0);
  if (positive.length) {
    const preferred = positive.filter((value) => value >= 0.1);
    return Math.min(...(preferred.length ? preferred : positive));
  }
  return values.includes(0) ? 0 : null;
}

function stripTags(html: string) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePercentText(text: string): number | null {
  if (!text) return null;
  const match = String(text).match(/-?[\d.]+/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function parseRankText(text: string) {
  if (!text) return '--';
  const cleaned = text.replace(/\s+/g, '');
  if (!cleaned || cleaned.includes('---')) return '--';
  return cleaned.replace('|', '/');
}

function parseRankChange(text: string) {
  const raw = text || '';
  const value = parsePercentText(raw);
  let direction: 'up' | 'down' | 'flat' = 'flat';
  if (raw.includes('↑')) direction = 'up';
  if (raw.includes('↓')) direction = 'down';
  if (raw.includes('---') || raw.includes('--')) direction = 'flat';
  return { value, direction };
}

function parseQuartile(text: string) {
  if (!text) return '--';
  const match = text.match(/优秀|良好|一般|不佳/);
  return match ? match[0] : text.replace(/\s+/g, '') || '--';
}

function normalizePeriodLabel(period?: string | null) {
  if (!period) return '近1年';
  const raw = String(period).trim();
  if (!raw) return '近1年';
  const map: Record<string, string> = {
    ytd: '今年以来',
    '1w': '近1周',
    '1m': '近1月',
    '3m': '近3月',
    '6m': '近6月',
    '1y': '近1年',
    '1yr': '近1年',
    '1year': '近1年',
    year: '近1年',
    '2y': '近2年',
    '3y': '近3年',
    '5y': '近5年',
    since: '成立以来'
  };
  const key = raw.toLowerCase();
  return map[key] || raw;
}

function parseJdzfRow(content: string, periodLabel: string) {
  if (!content) return null;
  const rowRegex = new RegExp(
    `<ul[^>]*>\\s*<li[^>]*class=['"]title['"][^>]*>${periodLabel}</li>[\\s\\S]*?<\\/ul>`,
    'i'
  );
  const rowMatch = content.match(rowRegex);
  if (!rowMatch) return null;
  const rowHtml = rowMatch[0];
  const liMatches = Array.from(rowHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)).map(
    (match) => match[1]
  );
  if (liMatches.length < 7) return null;
  const growthText = stripTags(liMatches[1]);
  const rankText = stripTags(liMatches[4]);
  const rankChangeText = stripTags(liMatches[5]);
  const quartileText = stripTags(liMatches[6]);
  return {
    growthPct: parsePercentText(growthText),
    rank: parseRankText(rankText),
    rankChange: parseRankChange(rankChangeText),
    quartile: parseQuartile(quartileText)
  };
}

function sanitizeHistoryContent(content: string) {
  if (!content) return '';
  return content
    .replace(/href='\/\//g, "href='https://")
    .replace(/href=\"\/\//g, 'href="https://')
    .replace(/href='\/f10/g, "href='https://fund.eastmoney.com/f10")
    .replace(/href=\"\/f10/g, 'href="https://fund.eastmoney.com/f10');
}

export async function searchFundsClient(q: string, limit = 8): Promise<SearchItem[]> {
  const trimmed = (q || '').trim();
  if (!trimmed) return [];
  const cbName = `FundSearch_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const url = `${FUND_SEARCH_URL}${encodeURIComponent(trimmed)}&callback=${cbName}&_=${Date.now()}`;
  return new Promise<SearchItem[]>((resolve) => {
    if (typeof document === 'undefined') return resolve([]);
    const script = document.createElement('script');
    const timer = window.setTimeout(() => {
      cleanup();
      resolve([]);
    }, 8000);
    const cleanup = () => {
      window.clearTimeout(timer);
      if (script.parentNode) script.parentNode.removeChild(script);
      delete (window as any)[cbName];
    };
    (window as any)[cbName] = (data: any) => {
      cleanup();
      const list = Array.isArray(data?.Datas) ? data.Datas : [];
      const filtered = list.filter(
        (item: any) =>
          item?.CATEGORY === 700 || item?.CATEGORY === '700' || String(item?.CATEGORYDESC || '').includes('基金')
      );
      const results = filtered.slice(0, limit).map((item: any) => ({
        code: String(item.CODE || '').trim(),
        abbr: String(item.SHORTNAME || item.NAME || '').trim(),
        name: String(item.NAME || item.SHORTNAME || '').trim(),
        type: String(item.CATEGORYDESC || item.CATEGORY || '').trim(),
        pinyin: String(item.PINYIN || '').trim()
      }));
      resolve(results.filter((item) => item.code));
    };
    script.src = url;
    script.async = true;
    script.onerror = () => {
      cleanup();
      resolve([]);
    };
    document.body.appendChild(script);
  });
}

export async function getFundHistoryClient(code: string, days = 365): Promise<{ name: string; history: FundHistoryPoint[] }> {
  const normalized = normalizeCode(code);
  if (!normalized) return { name: '', history: [] };
  const data = await loadPingzhong(normalized);
  const raw = Array.isArray(data.history) ? data.history : [];
  const history = raw
    .map((item: any) => {
      const time = item?.x ?? item?.[0];
      const nav = item?.y ?? item?.[1];
      const date = toDateString(time);
      const navValue = typeof nav === 'string' || typeof nav === 'number' ? Number(nav) : null;
      if (!date || navValue === null || !Number.isFinite(navValue)) return null;
      return { date, nav: navValue };
    })
    .filter(Boolean) as FundHistoryPoint[];

  const trimmed = days > 0 ? history.slice(-days) : history;
  const enriched = trimmed.map((item, idx) => {
    const prev = idx > 0 ? trimmed[idx - 1].nav : item.nav;
    const dailyGrowth = idx > 0 ? ((item.nav - prev) / prev) * 100 : 0;
    return {
      date: item.date,
      nav: item.nav,
      accumulated_value: item.nav,
      daily_growth_rate: Number(dailyGrowth.toFixed(2))
    };
  });

  return { name: data.name || '', history: enriched };
}

export async function getFundSummaryClient(code: string) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  let name = '';
  let latestNav: number | null = null;
  let latestDate = '';
  let estNav: number | null = null;
  let estPct: number | null = null;
  let updateTime = '';

  try {
    const gz = await loadJsonpgz(normalized);
    if (gz && typeof gz === 'object') {
      name = gz.name || name;
      latestNav = gz.dwjz ? Number(gz.dwjz) : latestNav;
      latestDate = gz.jzrq || latestDate;
      estNav = gz.gsz ? Number(gz.gsz) : estNav;
      estPct = gz.gszzl !== undefined && gz.gszzl !== null ? Number(gz.gszzl) : estPct;
      updateTime = gz.gztime || latestDate || updateTime;
    }
  } catch {
    // ignore
  }

  if (!latestNav || !latestDate) {
    try {
      const history = await getFundHistoryClient(normalized, 30);
      if (!name) name = history.name || normalized;
      const last = history.history[history.history.length - 1];
      if (last) {
        latestNav = last.nav;
        latestDate = last.date;
        updateTime = last.date || updateTime;
        if (last.daily_growth_rate !== undefined) estPct = last.daily_growth_rate;
        estNav = latestNav;
      }
    } catch {
      // ignore
    }
  }

  const feeRate = await getFundFeeRateClient(normalized);

  return {
    code: normalized,
    name: name || normalized,
    latestNav,
    latestDate,
    estNav,
    estPct,
    updateTime: updateTime || latestDate,
    feeRate
  };
}

export async function getFundHistoryTableClient(
  code: string,
  page = 1,
  per = 49
): Promise<FundHistoryTableData | null> {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const url = `${FUND_HISTORY_TABLE_URL}&code=${normalized}&page=${page}&per=${per}`;
  const data = await loadApidata(url);
  if (!data) return null;
  return {
    content: sanitizeHistoryContent(data.content || ''),
    pages: Number(data.pages) || null,
    currentPage: Number(data.curpage) || null,
    totalRecords: Number(data.records) || null
  };
}

export async function getFundPerformanceClient(code: string, period?: string | null): Promise<FundPerformance | null> {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const url = `${FUND_JDZF_URL}&code=${normalized}&rt=${Math.random()}`;
  const data = await loadApidata(url);
  const content = data?.content || '';
  const periodLabel = normalizePeriodLabel(period);
  const parsed = parseJdzfRow(content, periodLabel);
  if (!parsed) return null;
  return {
    period: periodLabel,
    growthPct: parsed.growthPct,
    rank: parsed.rank,
    rankChange: parsed.rankChange,
    quartile: parsed.quartile
  };
}

export async function getFundPositionsClient(code: string): Promise<FundPositionData | null> {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const url = `${FUND_POSITION_URL}&code=${normalized}&topline=10&year=&month=&_=${Date.now()}`;
  const data = await loadApidata(url);
  if (!data) return null;
  return {
    content: data.content || '',
    years: [],
    currentYear: '',
    holdings: [],
    date: '',
    source: '东方财富'
  };
}

export async function getStockQuotesClient(codes: string[]): Promise<Record<string, StockQuote>> {
  const normalized = Array.from(new Set(codes.filter(Boolean)));
  if (!normalized.length) return {};

  const now = Date.now();
  const result: Record<string, StockQuote> = {};
  const secids: string[] = [];

  const normalizeKey = (code: string) => {
    if (code.includes('.')) return code.split('.').pop()!.toUpperCase();
    return code.toUpperCase();
  };

  normalized.forEach((code) => {
    const key = normalizeKey(code);
    const cached = stockQuoteCache.get(key);
    if (cached && now - cached.fetchedAt < STOCK_QUOTE_TTL) {
      result[key] = cached.data;
      return;
    }
    if (code.includes('.')) {
      secids.push(code);
      return;
    }
    if (/^\d{6}$/.test(code)) {
      secids.push(code.startsWith('6') ? `1.${code}` : `0.${code}`);
      return;
    }
    const ticker = code.toUpperCase();
    secids.push(`105.${ticker}`);
    secids.push(`106.${ticker}`);
  });

  const uniqueSecids = Array.from(new Set(secids));
  const chunks: string[][] = [];
  for (let i = 0; i < uniqueSecids.length; i += 50) {
    chunks.push(uniqueSecids.slice(i, i + 50));
  }

  for (const chunk of chunks) {
    const secidsParam = chunk.join(',');
    if (!secidsParam) continue;
    const url = `${STOCK_QUOTE_URL}?fltt=2&invt=2&fields=${encodeURIComponent(
      STOCK_QUOTE_FIELDS
    )}&secids=${encodeURIComponent(secidsParam)}`;
    const data = await loadJsonp(url);
    const diff = data?.data?.diff || [];
    diff.forEach((item: any) => {
      const code = String(item?.f12 || '').trim().toUpperCase();
      if (!code) return;
      const quote: StockQuote = {
        code,
        name: item?.f14 || '',
        price: toNumber(item?.f2),
        pct: toNumber(item?.f3)
      };
      result[code] = quote;
      stockQuoteCache.set(code, { data: quote, fetchedAt: now });
    });
  }

  return result;
}

export async function getFundFeeRateClient(code: string): Promise<number | null> {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  try {
    const url = `${FUND_FEE_API_URL}&code=${normalized}`;
    const data = await loadApidata(url);
    const content = data?.content || '';
    return extractFeeRateFromContent(content);
  } catch {
    return null;
  }
}
