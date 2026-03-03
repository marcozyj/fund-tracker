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
const FUND_HISTORY_TABLE_URL = 'https://fundf10.eastmoney.com/F10DataApi.aspx?type=lsjz';
const FUND_FEE_API_URL = 'https://fundf10.eastmoney.com/F10DataApi.aspx?type=jjfl';
const FUND_JDZF_URL = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jdzf';
const FUND_POSITION_URL = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc';
const TT_POSITION_URL = 'https://dgs.tiantianfunds.com/merge/m/api/jjxqy2';
const TT_POSITION_DEVICE_ID = '9a8d612d1a2229b7bf0ffd5ca823d790';
const TT_POSITION_VALIDMARK = '9a8d612d1a2229b7bf0ffd5ca823d790';
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

async function fetchJsonPost(url: string, body: string, headers?: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(headers || {}) },
    body,
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
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

function parsePositionDateFromContent(content: string) {
  if (!content) return '';
  const dateMatch = content.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (dateMatch) {
    const year = dateMatch[1];
    const month = dateMatch[2].padStart(2, '0');
    const day = dateMatch[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const quarterMatch = content.match(/(\d{4})年(\d{1,2})季度/);
  if (quarterMatch) {
    const year = quarterMatch[1];
    const quarter = Number(quarterMatch[2]);
    if (Number.isFinite(quarter) && quarter >= 1 && quarter <= 4) {
      const month = String(quarter * 3).padStart(2, '0');
      const day = quarter === 1 || quarter === 4 ? '31' : '30';
      return `${year}-${month}-${day}`;
    }
  }
  return '';
}

function quarterEndDate(year: number, quarter: number) {
  const month = String(quarter * 3).padStart(2, '0');
  const day = quarter === 1 || quarter === 4 ? '31' : '30';
  return `${year}-${month}-${day}`;
}

function previousQuarterFromDate(date: string) {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  let year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  let prevMonth = 12;
  if (month >= 10) prevMonth = 9;
  else if (month >= 7) prevMonth = 6;
  else if (month >= 4) prevMonth = 3;
  else {
    prevMonth = 12;
    year -= 1;
  }
  return { year, month: prevMonth };
}

function extractCodeFromPositionRow(row: Element) {
  const html = row.innerHTML;
  const secidMatch = html.match(/unify\/r\/(\d+)\.([A-Za-z0-9]+)/i);
  if (secidMatch && secidMatch[2]) return secidMatch[2].toUpperCase();
  const ccmxMatch = html.match(/ccmx_(\d{6})/);
  if (ccmxMatch && ccmxMatch[1]) return ccmxMatch[1];
  const text = row.textContent || '';
  const sixMatch = text.match(/\b\d{6}\b/);
  if (sixMatch) return sixMatch[0];
  const fiveMatch = text.match(/\b\d{5}\b/);
  if (fiveMatch) return fiveMatch[0];
  const tickerMatch = text.match(/\b[A-Z]{1,6}\b/);
  if (tickerMatch) return tickerMatch[0].toUpperCase();
  return '';
}

function extractSecidFromPositionRow(row: Element) {
  const html = row.innerHTML;
  const secidMatch = html.match(/unify\/r\/(\d+)\.([A-Za-z0-9]+)/i);
  if (!secidMatch) return '';
  const market = secidMatch[1];
  const code = secidMatch[2];
  if (!market || !code) return '';
  return `${market}.${code.toUpperCase()}`;
}

function parseSecidMapFromContent(content: string) {
  if (!content) return new Map<string, string>();
  const map = new Map<string, string>();
  const regex = /(\d{1,3})\.([A-Za-z]{1,6}|\d{4,6})/g;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(content))) {
    const market = match[1];
    const code = match[2].toUpperCase();
    if (!market || !code) continue;
    map.set(code, `${market}.${code}`);
  }
  return map;
}

function parsePositionHoldingsFromContent(content: string) {
  if (!content || typeof DOMParser === 'undefined') return [];
  const doc = new DOMParser().parseFromString(content, 'text/html');
  const tables = Array.from(doc.querySelectorAll('table'));
  if (!tables.length) return [];

  const secidMap = parseSecidMapFromContent(content);
  const normalizeText = (value: string) => value.replace(/\s+/g, '').trim();
  const target =
    tables.find((table) => {
      const header = table.querySelector('tr');
      if (!header) return false;
      const text = normalizeText(header.textContent || '');
      return text.includes('股票代码') || text.includes('股票名称') || text.includes('股票简称');
    }) || tables[0];

  const rows = Array.from(target.querySelectorAll('tr'));
  if (!rows.length) return [];
  const headerRow =
    rows.find((row) => (row.textContent || '').includes('股票代码')) || rows[0];
  const headerCells = Array.from(headerRow.children);
  const headerTexts = headerCells.map((cell) => normalizeText(cell.textContent || ''));

  const findHeaderIndex = (predicates: string[]) =>
    headerTexts.findIndex((text) => predicates.some((key) => text.includes(key)));

  const codeIndex = findHeaderIndex(['股票代码', '代码']);
  const nameIndex = findHeaderIndex(['股票名称', '股票简称', '名称', '简称']);
  const weightIndex = findHeaderIndex(['占净值', '占净值比例', '持仓占比', '占资产']);
  const changeIndex = findHeaderIndex(['涨跌幅', '涨幅', '跌幅', '涨跌']);

  const parsePercentCell = (text: string) => {
    if (!text) return null;
    if (!/%|％/.test(text)) return null;
    const value = parsePercentText(text);
    if (value === null || !Number.isFinite(value)) return null;
    if (value < -100 || value > 100) return null;
    return value;
  };

  const holdings: {
    code: string;
    name: string;
    weight: number | null;
    secid?: string;
  }[] = [];

  rows.forEach((row, idx) => {
    if (idx === rows.indexOf(headerRow)) return;
    if (row.querySelector('th')) return;
    const cells = Array.from(row.children);
    if (!cells.length) return;
    const code = extractCodeFromPositionRow(row) || (cells[codeIndex]?.textContent || '').trim();
    const name =
      (cells[nameIndex]?.textContent || '').trim() ||
      (codeIndex >= 0 ? (cells[codeIndex + 1]?.textContent || '').trim() : '');
    if (!code && !name) return;
    let weight: number | null = null;
    if (weightIndex >= 0 && weightIndex < cells.length) {
      const weightText = cells[weightIndex]?.textContent || '';
      weight = parsePercentCell(weightText);
    }
    if (weight === null) {
      const candidates = cells
        .map((cell, index) => ({
          index,
          value: parsePercentCell(cell.textContent || '')
        }))
        .filter((item) => item.value !== null) as { index: number; value: number }[];
      const filtered = changeIndex >= 0 ? candidates.filter((item) => item.index !== changeIndex) : candidates;
      const picked = filtered.length ? filtered[filtered.length - 1] : candidates[candidates.length - 1];
      if (picked) weight = picked.value;
    }
    const secid = extractSecidFromPositionRow(row) || secidMap.get(code.toUpperCase()) || '';
    holdings.push({
      code: code.toUpperCase(),
      name,
      weight,
      secid: secid || undefined
    });
  });

  return holdings;
}

function parseQuarterPositionSections(content: string) {
  if (!content) return [];
  const sections: { date: string; holdings: ReturnType<typeof parsePositionHoldingsFromContent> }[] = [];
  const regex = /(\d{4})年(\d{1,2})季度[^<>]*?投资明细/g;
  const matches: { index: number; year: number; quarter: number }[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(content))) {
    matches.push({
      index: match.index,
      year: Number(match[1]),
      quarter: Number(match[2])
    });
  }

  if (!matches.length) {
    const holdings = parsePositionHoldingsFromContent(content);
    if (holdings.length) {
      sections.push({ date: parsePositionDateFromContent(content), holdings });
    }
    return sections;
  }

  matches.forEach((item, idx) => {
    const start = item.index;
    const end = idx + 1 < matches.length ? matches[idx + 1].index : content.length;
    const chunk = content.slice(start, end);
    const holdings = parsePositionHoldingsFromContent(chunk);
    if (!holdings.length) return;
    let date = parsePositionDateFromContent(chunk);
    if (!date && Number.isFinite(item.year) && Number.isFinite(item.quarter)) {
      date = quarterEndDate(item.year, item.quarter);
    }
    sections.push({ date, holdings });
  });

  return sections;
}

function applyHoldingChanges(
  latest: { code: string; name: string; weight: number | null; secid?: string }[],
  previous: { code: string; weight: number | null }[],
  hasPrevious = previous.length > 0
) {
  if (!hasPrevious) {
    return latest.map((item) => ({
      ...item,
      change: null,
      changeType: ''
    }));
  }
  const prevMap = new Map<string, number | null>();
  previous.forEach((item) => {
    if (!item.code) return;
    prevMap.set(item.code.toUpperCase(), item.weight ?? null);
  });

  return latest.map((item) => {
    const prevWeight = prevMap.get(item.code.toUpperCase());
    if (prevWeight === undefined) {
      return {
        ...item,
        change: null,
        changeType: '新增'
      };
    }
    const nextWeight = item.weight ?? null;
    if (prevWeight === null || nextWeight === null || !Number.isFinite(nextWeight)) {
      return {
        ...item,
        change: null,
        changeType: ''
      };
    }
    const delta = Number((nextWeight - prevWeight).toFixed(2));
    if (Math.abs(delta) < 0.01) {
      return {
        ...item,
        change: 0,
        changeType: '持平'
      };
    }
    return {
      ...item,
      change: delta,
      changeType: delta > 0 ? '增持' : '减持'
    };
  });
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

  try {
    const history = await getFundHistoryClient(normalized, 60);
    if (!name) name = history.name || normalized;
    const last = history.history[history.history.length - 1];
    if (last) {
      if (!latestDate || last.date > latestDate) {
        latestNav = last.nav;
        latestDate = last.date;
        estNav = latestNav;
        estPct = last.daily_growth_rate ?? estPct;
        if (!updateTime || updateTime < last.date) {
          updateTime = last.date;
        }
      } else if (last.date === latestDate && estPct === null && last.daily_growth_rate !== undefined) {
        estPct = last.daily_growth_rate;
      }
    }
  } catch {
    // ignore
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
  try {
    const params = new URLSearchParams();
    params.set('deviceid', TT_POSITION_DEVICE_ID);
    params.set('version', '9.9.9');
    params.set('appVersion', '6.5.5');
    params.set('product', 'EFund');
    params.set('plat', 'Web');
    params.set('uid', '');
    params.set('fcode', normalized);

    const ttData = await fetchJsonPost(TT_POSITION_URL, params.toString(), {
      validmark: TT_POSITION_VALIDMARK
    });
    const fundStocks = ttData?.data?.fundInverstPosition?.fundStocks || [];
    const date = ttData?.data?.FundXTChangeInfo?.holdDate || ttData?.data?.expansion || '';
    if (Array.isArray(fundStocks) && fundStocks.length) {
      const holdings = fundStocks.map((item: any) => {
        const code = String(item?.GPDM || '').trim().toUpperCase();
        const market = String(item?.NEWTEXCH || '').trim();
        let secid = '';
        if (market && code) secid = `${market}.${code}`;
        else if (/^\d{6}$/.test(code)) secid = code.startsWith('6') ? `1.${code}` : `0.${code}`;
        return {
          code,
          name: String(item?.GPJC || '').trim(),
          market,
          weight: toNumber(item?.JZBL),
          change: toNumber(item?.PCTNVCHG),
          changeType: item?.PCTNVCHGTYPE ? String(item.PCTNVCHGTYPE) : '',
          secid
        };
      });
      const codes = holdings.map((item) => item.secid || item.code).filter(Boolean);
      const quotes = codes.length ? await getStockQuotesClient(codes) : {};
      return {
        content: '',
        years: [],
        currentYear: '',
        holdings,
        date,
        source: '天天基金',
        quotes
      };
    }
  } catch {
    // fall through to eastmoney
  }

  const url = `${FUND_POSITION_URL}&code=${normalized}&topline=10&year=&month=&rt=${Date.now()}`;
  const data = await loadApidata(url);
  if (!data) return null;
  const content = data.content || '';
  const sections = parseQuarterPositionSections(content);
  if (!sections.length) {
    return {
      content,
      years: [],
      currentYear: '',
      holdings: [],
      date: parsePositionDateFromContent(content),
      source: '东方财富'
    };
  }

  const sorted = sections
    .filter((item) => item.date)
    .sort((a, b) => b.date.localeCompare(a.date));
  const latest = sorted[0] || sections[0];
  let previous = sorted[1];
  let hasPrevious = Boolean(previous && previous.holdings.length);

  if (!previous && latest?.date) {
    const prevQuarter = previousQuarterFromDate(latest.date);
    if (prevQuarter) {
      const prevUrl = `${FUND_POSITION_URL}&code=${normalized}&topline=10&year=${prevQuarter.year}&month=${prevQuarter.month}&rt=${Date.now()}`;
      const prevData = await loadApidata(prevUrl);
      const prevContent = prevData?.content || '';
      const prevSections = parseQuarterPositionSections(prevContent);
      if (prevSections.length) {
        const prevSorted = prevSections
          .filter((item) => item.date)
          .sort((a, b) => b.date.localeCompare(a.date));
        previous = prevSorted[0] || prevSections[0];
        hasPrevious = Boolean(previous && previous.holdings.length);
      }
    }
  }

  const prevHoldings = previous
    ? previous.holdings.map((item) => ({
        code: item.code,
        weight: item.weight ?? null
      }))
    : [];
  const enrichedHoldings = applyHoldingChanges(latest.holdings, prevHoldings, hasPrevious);
  const codes = enrichedHoldings.map((item) => item.secid || item.code).filter(Boolean);
  const quotes = codes.length ? await getStockQuotesClient(codes) : {};

  return {
    content,
    years: [],
    currentYear: '',
    holdings: enrichedHoldings,
    date: latest.date,
    source: '东方财富',
    quotes
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
