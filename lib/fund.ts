import type {
  SearchItem,
  FundHistoryPoint,
  FundPositionData,
  FundHistoryTableData,
  FundPerformance,
  StockQuote,
  FundPositionItem
} from './types';
const SEARCH_URL = 'https://fund.eastmoney.com/js/fundcode_search.js';
const PINGZHONG_URL = 'https://fund.eastmoney.com/pingzhongdata/';
const FUND_HISTORY_TABLE_URL = 'http://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz';
const FUND_FEE_URL = 'https://fundf10.eastmoney.com/jjfl_';
const FUND_FEE_API_URL = 'http://fund.eastmoney.com/f10/F10DataApi.aspx?type=jjfl';
const FUND_JDZF_URL = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jdzf';
const FUND_OVERVIEW_URL = 'https://fund.eastmoney.com/';
const TT_POSITION_URL = 'https://dgs.tiantianfunds.com/merge/m/api/jjxqy2';
const TT_POSITION_DEVICE_ID = '9a8d612d1a2229b7bf0ffd5ca823d790';
const TT_POSITION_VALIDMARK = '9a8d612d1a2229b7bf0ffd5ca823d790';
const TT_FEE_URL = 'https://dgs.tiantianfunds.com/merge/m/api/jjxqy1_2';
const TT_DEVICE_ID = '64c45625839c28d22f2b422be3e692ba';
const TT_VALIDMARK = '64c45625839c28d22f2b422be3e692ba';
const TT_INDEX_FIELDS = 'indexfields=_id,INDEXCODE,BKID,INDEXNAME,INDEXVALUA,NEWINDEXTEXCH,PEP100';
const TT_FIELDS =
  'fields=BENCH,ESTDIFF,INDEXNAME,LINKZSB,INDEXCODE,NEWTEXCH,FTYPE,FCODE,BAGTYPE,RISKLEVEL,TTYPENAME,PTDT_FY,PTDT_TRY,PTDT_TWY,PTDT_Y,DWDT_FY,DWDT_TRY,DWDT_TWY,DWDT_Y,MBDT_FY,MBDT_TRY,MBDT_TWY,MBDT_Y,YDDT_FY,YDDT_TRY,YDDT_TWY,YDDT_Y,BFUNDTYPE,YMATCHCODEA,RLEVEL_SZ,RLEVEL_CX,ESTABDATE,JJGS,JJGSID,ENDNAV,FEGMRQ,SHORTNAME,TTYPE,TJDIN,FUNDEXCHG,LISTTEXCHMARK,FSRQ,ISSBDATE,ISSEDATE,FEATURE,DWJZ,LJJZ,MINRG,RZDF,PERIODNAME,SYL_1N,SYL_LN,SYL_Z,SOURCERATE,RATE,TSRQ,BTYPE,BUY,BENCHCODE,BENCH_CORR,TRKERROR,BENCHRATIO,NEWINDEXTEXCH,BESTDT_STRATEGY,BESTDT_Y,BESTDT_TWY,BESTDT_TRY,BESTDT_FY';
const TT_UNIQUE_FIELDS =
  'fundUniqueInfo_fIELDS=FCODE,STDDEV1,STDDEV_1NRANK,STDDEV_1NFSC,STDDEV3,STDDEV_3NRANK,STDDEV_3NFSC,STDDEV5,STDDEV_5NRANK,STDDEV_5NFSC,SHARP1,SHARP_1NRANK,SHARP_1NFSC,SHARP3,SHARP_3NRANK,SHARP_3NFSC,SHARP5,SHARP_5NRANK,SHARP_5NFSC,MAXRETRA1,MAXRETRA_1NRANK,MAXRETRA_1NFSC,MAXRETRA3,MAXRETRA_3NRANK,MAXRETRA_3NFSC,MAXRETRA5,MAXRETRA_5NRANK,MAXRETRA_5NFSC,TRKERROR1,TRKERROR_1NRANK,TRKERROR_1NFSC,TRKERROR3,TRKERROR_3NRANK,TRKERROR_3NFSC,TRKERROR5,TRKERROR_5NRANK,TRKERROR_5NFSC';
const TT_UNIQUE_FL_FIELDS =
  'fundUniqueInfo_fLFIELDS=FCODE,BUSINESSTYPE,BUSINESSTEXT,BUSINESSCODE,BUSINESSSUBTYPE,MARK';
const TT_CFH_FIELDS = 'cfhFundFInfo_fields=INVESTMENTIDEAR,INVESTMENTIDEARIMG';
const TT_RELATE_FIELDS = 'relateThemeFields=FCODE,SEC_CODE,SEC_NAME,CORR_1Y,OL2TOP';
const STOCK_QUOTE_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get';
const STOCK_QUOTE_OVERSEAS_FIELDS = 'f1,f2,f3,f4,f12,f13,f14,f29,f292';
const SEARCH_TTL = 12 * 60 * 60 * 1000;
const POSITION_TTL = 6 * 60 * 60 * 1000;
const HISTORY_TABLE_TTL = 6 * 60 * 60 * 1000;
const QUOTE_TTL = 2 * 60 * 1000;
const FEE_TTL = 6 * 60 * 60 * 1000;
const JDZF_TTL = 6 * 60 * 60 * 1000;

let searchCache: { list: SearchItem[]; fetchedAt: number } = {
  list: [],
  fetchedAt: 0
};

const positionCache = new Map<string, { data: FundPositionData; fetchedAt: number }>();
const historyTableCache = new Map<string, { data: FundHistoryTableData; fetchedAt: number }>();
const quoteCache = new Map<string, { data: StockQuote; fetchedAt: number }>();
const feeCache = new Map<string, { data: number | null; fetchedAt: number }>();
const jdzfCache = new Map<string, { data: FundPerformance; fetchedAt: number }>();

export function normalizeCode(code: string) {
  const raw = String(code || '').trim();
  if (!raw) return '';
  const digits = raw.match(/\d+/g);
  const merged = digits ? digits.join('') : '';
  if (!merged) return '';
  return merged.length < 6 ? merged.padStart(6, '0') : merged;
}

function containsCjk(text: string) {
  return /[\u4e00-\u9fff]/.test(text);
}

function toNumber(value: any) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

const CN_TIMEZONE = 'Asia/Shanghai';
const cnFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CN_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

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

async function fetchText(url: string) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.text();
}

async function fetchTextEncoded(url: string, encoding: string) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const decoder = new TextDecoder(encoding);
  return decoder.decode(buffer);
}

async function fetchTextSmart(url: string) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  const gbk = new TextDecoder('gbk').decode(buffer);
  return { utf8, gbk };
}

async function fetchJson(url: string) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
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

async function loadSearchList(): Promise<SearchItem[]> {
  const now = Date.now();
  if (searchCache.list.length && now - searchCache.fetchedAt < SEARCH_TTL) {
    return searchCache.list;
  }

  const text = await fetchText(`${SEARCH_URL}?rt=${Date.now()}`);
  let list: SearchItem[] = [];
  const match = text.match(/var\s+r\s*=\s*([\s\S]*?);/);
  if (match && match[1]) {
    try {
      const raw = JSON.parse(match[1]);
      if (Array.isArray(raw)) {
        list = raw.map((item: any[]) => ({
          code: item?.[0] || '',
          abbr: item?.[1] || '',
          name: item?.[2] || '',
          type: item?.[3] || '',
          pinyin: item?.[4] || ''
        }));
      }
    } catch {
      list = [];
    }
  }

  searchCache = { list, fetchedAt: now };
  return list;
}

export async function searchFunds(q: string, limit = 8): Promise<SearchItem[]> {
  const trimmed = (q || '').trim();
  if (!trimmed) return [];
  const list = await loadSearchList();
  if (!list.length) return [];

  const lower = trimmed.toLowerCase();
  const isCjkQuery = containsCjk(trimmed);

  const matches = list.filter((item) => {
    if (!item.code) return false;
    if (/^\d+$/.test(lower)) {
      return item.code.includes(lower);
    }
    if (isCjkQuery) {
      return item.name.includes(trimmed);
    }
    return (
      item.abbr.toLowerCase().includes(lower) ||
      item.pinyin.toLowerCase().includes(lower) ||
      item.name.toLowerCase().includes(lower)
    );
  });

  const normalized = normalizeCode(trimmed);
  if (/^\d{6}$/.test(normalized) && matches.length === 0) {
    return [{ code: normalized, abbr: '', name: '', type: '', pinyin: '' }];
  }

  return matches.slice(0, limit);
}

export async function getFundHistory(code: string, days = 365): Promise<{ name: string; history: FundHistoryPoint[] }> {
  const normalized = normalizeCode(code);
  if (!normalized) return { name: '', history: [] };

  const text = await fetchText(`${PINGZHONG_URL}${normalized}.js?v=${Date.now()}`);
  const fn = new Function(
    `${text}; return { Data_netWorthTrend: typeof Data_netWorthTrend !== 'undefined' ? Data_netWorthTrend : [], fS_name: typeof fS_name !== 'undefined' ? fS_name : '' };`
  );
  const data = fn() as { Data_netWorthTrend: any[]; fS_name: string };
  const raw = Array.isArray(data.Data_netWorthTrend) ? data.Data_netWorthTrend : [];
  const history = raw
    .map((item) => {
      const time = item?.x ?? item?.[0];
      const nav = item?.y ?? item?.[1];
      const date = toDateString(time);
      const navValue = toNumber(nav);
      if (!date || navValue === null) return null;
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

  return { name: data.fS_name || '', history: enriched };
}

export async function getFundPositions(code: string): Promise<FundPositionData | null> {
  const normalized = normalizeCode(code);
  if (!normalized) return null;

  const cached = positionCache.get(normalized);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < POSITION_TTL) {
    return cached.data;
  }

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
    const source = '天天基金';
    if (Array.isArray(fundStocks) && fundStocks.length) {
      const holdings: FundPositionItem[] = fundStocks.map((item: any) => {
        const code = String(item?.GPDM || '').trim().toUpperCase();
        const market = String(item?.NEWTEXCH || '').trim();
        const secid = market && code ? `${market}.${code}` : '';
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
      const payload: FundPositionData = {
        content: '',
        years: [],
        currentYear: '',
        holdings,
        date,
        source
      };
      positionCache.set(normalized, { data: payload, fetchedAt: now });
      return payload;
    }
  } catch {
    // fall through
  }
  return null;
}


export async function getStockQuotes(codes: string[]): Promise<Record<string, StockQuote>> {
  const normalized = Array.from(new Set(codes.filter(Boolean)));
  if (!normalized.length) return {};

  const now = Date.now();
  const result: Record<string, StockQuote> = {};
  const pendingA: string[] = [];
  const pendingOverseas: string[] = [];

  const normalizeKey = (code: string) => {
    if (code.includes('.')) return code.split('.').pop()!.toUpperCase();
    return code.toUpperCase();
  };

  normalized.forEach((code) => {
    const key = normalizeKey(code);
    const cached = quoteCache.get(key);
    if (cached && now - cached.fetchedAt < QUOTE_TTL) {
      result[key] = cached.data;
      return;
    }
    if (code.includes('.')) {
      const suffix = code.split('.').pop() || '';
      if (/^\d{6}$/.test(suffix)) {
        pendingA.push(code);
      } else {
        pendingOverseas.push(code);
      }
      return;
    }
    if (/^\d{6}$/.test(code)) {
      pendingA.push(code);
      return;
    }
    pendingOverseas.push(code);
  });

  const toSecId = (code: string) => {
    if (code.includes('.')) return code;
    if (code.startsWith('6')) return `1.${code}`;
    if (code.startsWith('0') || code.startsWith('3')) return `0.${code}`;
    return '';
  };

  const chunks: string[][] = [];
  const batchSize = 50;
  const pendingASecids = Array.from(new Set(pendingA.map((code) => toSecId(code)).filter(Boolean)));
  for (let i = 0; i < pendingASecids.length; i += batchSize) {
    chunks.push(pendingASecids.slice(i, i + batchSize));
  }

  for (const chunk of chunks) {
    const secids = chunk.join(',');
    if (!secids) continue;
    const url = `${STOCK_QUOTE_URL}?fltt=2&invt=2&fields=f12,f14,f2,f3&secids=${encodeURIComponent(secids)}`;
    const data = await fetchJson(url);
    const diff = data?.data?.diff || [];
    diff.forEach((item: any) => {
      const code = String(item?.f12 || '').trim();
      if (!code) return;
      const quote: StockQuote = {
        code,
        name: item?.f14 || '',
        price: toNumber(item?.f2),
        pct: toNumber(item?.f3)
      };
      result[code] = quote;
      quoteCache.set(code, { data: quote, fetchedAt: now });
    });
  }

  const overseasSecids = new Set<string>();
  pendingOverseas.forEach((code) => {
    if (!code) return;
    if (code.includes('.')) {
      overseasSecids.add(code);
      return;
    }
    const ticker = code.toUpperCase();
    overseasSecids.add(`105.${ticker}`);
    overseasSecids.add(`106.${ticker}`);
  });

  if (overseasSecids.size) {
    const params = new URLSearchParams();
    params.set('deviceid', '65508749-27FF-48C1-9D86-AFF388D161B1');
    params.set('version', '6.9.9');
    params.set('appVersion', '6.9.9');
    params.set('product', 'EFund');
    params.set('plat', 'web');
    params.set('secids', Array.from(overseasSecids).join(','));
    params.set('wbp2u', '');
    params.set('fields', STOCK_QUOTE_OVERSEAS_FIELDS);
    params.set('fltt', '2');
    params.set('invt', '2');

    const data = await fetchJsonPost(STOCK_QUOTE_URL, params.toString());
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
      if (!result[code] || result[code].price === null) {
        result[code] = quote;
        quoteCache.set(code, { data: quote, fetchedAt: now });
      }
    });
  }

  return result;
}

export async function getFundHistoryTable(
  code: string,
  page = 1,
  per = 49
): Promise<FundHistoryTableData | null> {
  const normalized = normalizeCode(code);
  if (!normalized) return null;

  const cacheKey = `${normalized}:${page}:${per}`;
  const cached = historyTableCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < HISTORY_TABLE_TTL) {
    return cached.data;
  }

  const url = `${FUND_HISTORY_TABLE_URL}&code=${normalized}&page=${page}&per=${per}`;
  const text = await fetchText(url);
  const data = parseFundHistoryTableResponse(text);
  if (!data) return null;

  const content = sanitizeFundHistoryContent(data.content || '');
  const payload: FundHistoryTableData = {
    content,
    pages: toNumber(data.pages) ?? null,
    currentPage: toNumber(data.curpage) ?? null,
    totalRecords: toNumber(data.records) ?? null
  };

  historyTableCache.set(cacheKey, { data: payload, fetchedAt: now });
  return payload;
}

export async function getFundBasic(code: string): Promise<SearchItem | null> {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const list = await loadSearchList();
  const found = list.find((item) => item.code === normalized);
  return found || null;
}

export async function getFundFeeRate(code: string, force = false): Promise<number | null> {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const cached = feeCache.get(normalized);
  const now = Date.now();
  if (!force && cached && now - cached.fetchedAt < FEE_TTL && cached.data !== 0) {
    return cached.data;
  }

  try {
    const ttRate = await getFeeRateFromTiantian(normalized);
    if (ttRate !== null) {
      feeCache.set(normalized, { data: ttRate, fetchedAt: now });
      return ttRate;
    }
  } catch {
    // fall back to other sources
  }

  const url = `${FUND_FEE_URL}${normalized}.html?rt=${Date.now()}`;
  try {
    const text = await fetchTextEncoded(url, 'gbk');
    let rate = extractFeeRate(text);
    if (rate === null) {
      const apiUrl = `${FUND_FEE_API_URL}&code=${normalized}`;
      const apiText = await fetchText(apiUrl);
      const apiData = parseFundHistoryTableResponse(apiText);
      const apiContent = apiData?.content || '';
      rate = apiContent ? extractFeeRate(apiContent) : rate;
    }

    if (rate === null || rate === 0 || rate === 0.12 || rate === 0.03) {
      const overviewUrl = `${FUND_OVERVIEW_URL}${normalized}.html`;
      const { utf8, gbk } = await fetchTextSmart(overviewUrl);
      const overviewRate = extractPurchaseFee(utf8) ?? extractPurchaseFee(gbk);
      if (overviewRate !== null && Number.isFinite(overviewRate)) {
        rate = overviewRate;
      }
    }

    feeCache.set(normalized, { data: rate, fetchedAt: now });
    return rate;
  } catch {
    return cached ? cached.data : null;
  }
}

export function computePerformance(history: FundHistoryPoint[]) {
  if (!history.length) return null;
  const last = history[history.length - 1];
  const calc = (offset: number) => {
    if (history.length <= offset) return null;
    const prev = history[history.length - 1 - offset].nav;
    if (!prev) return null;
    return Number((((last.nav - prev) / prev) * 100).toFixed(2));
  };

  return {
    date: last.date,
    week_return: calc(5),
    month_return: calc(22),
    quarter_return: calc(66),
    half_year_return: calc(132),
    year_return: calc(252),
    three_year_return: calc(756)
  };
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

function normalizePeriodLabel(period?: string | null) {
  if (!period) return '近1年';
  const raw = String(period).trim();
  if (!raw) return '近1年';
  const map: Record<string, string> = {
    ytd: '今年来',
    '1w': '近1周',
    '1m': '近1月',
    '3m': '近3月',
    '6m': '近6月',
    '1y': '近1年',
    '1yr': '近1年',
    '1year': '近1年',
    year: '近1年',
    '近1年': '近1年',
    '2y': '近2年',
    '3y': '近3年',
    '5y': '近5年',
    since: '成立来'
  };
  const key = raw.toLowerCase();
  return map[key] || raw;
}

export async function getFundPerformance(code: string, period?: string | null): Promise<FundPerformance | null> {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const periodLabel = normalizePeriodLabel(period);
  const cacheKey = `${normalized}:${periodLabel}`;
  const cached = jdzfCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < JDZF_TTL) {
    return cached.data;
  }

  const url = `${FUND_JDZF_URL}&code=${normalized}&rt=${Math.random()}`;
  const text = await fetchText(url);
  const data = parseFundHistoryTableResponse(text);
  const content = data?.content || '';
  const parsed = parseJdzfRow(content, periodLabel);
  if (!parsed) return null;
  const payload: FundPerformance = {
    period: periodLabel,
    growthPct: parsed.growthPct,
    rank: parsed.rank,
    rankChange: parsed.rankChange,
    quartile: parsed.quartile
  };
  jdzfCache.set(cacheKey, { data: payload, fetchedAt: now });
  return payload;
}


function parseFundHistoryTableResponse(text: string) {
  if (!text) return null;
  try {
    const fn = new Function(
      `${text}; return typeof apidata !== 'undefined' ? apidata : null;`
    );
    return fn();
  } catch {
    return null;
  }
}

function sanitizeFundHistoryContent(content: string) {
  if (!content) return '';
  return content
    .replace(/href='\/\//g, "href='https://")
    .replace(/href=\"\/\//g, 'href="https://')
    .replace(/href='\/f10/g, "href='https://fund.eastmoney.com/f10")
    .replace(/href=\"\/f10/g, 'href="https://fund.eastmoney.com/f10');
}

function extractFeeRate(html: string): number | null {
  if (!html) return null;
  const purchaseMatch = html.match(/购买手续费[\s\S]*?<b[^>]*>([\d.]+)%<\/b>\s*&nbsp;\s*<b[^>]*>([\d.]+)%<\/b>/i);
  if (purchaseMatch) {
    const discounted = Number(purchaseMatch[2]);
    const raw = Number(purchaseMatch[1]);
    if (Number.isFinite(discounted)) return discounted;
    if (Number.isFinite(raw)) return raw;
  }
  const anchorMatch =
    html.match(/申购费率/) ||
    html.match(/前端申购费率/) ||
    html.match(/购买费率/) ||
    html.match(/认购费率/);
  let slice = html;
  if (anchorMatch && anchorMatch.index !== undefined) {
    const start = anchorMatch.index;
    const tail = html.slice(start);
    const endMatch = tail.match(/赎回费率|管理费率|托管费率|销售服务费|运作费率|其他费用/);
    const endIndex = endMatch && endMatch.index !== undefined ? start + endMatch.index : start + 12000;
    slice = html.slice(start, endIndex);
    if (!slice.toLowerCase().includes('<table')) {
      const windowSlice = html.slice(start, start + 12000);
      const tableStart = windowSlice.search(/<table/i);
      if (tableStart >= 0) {
        const tableChunk = windowSlice.slice(tableStart);
        const tableEnd = tableChunk.search(/<\/table>/i);
        if (tableEnd >= 0) {
          slice = tableChunk.slice(0, tableEnd + 8);
        } else {
          slice = windowSlice;
        }
      }
    }
  }
  const matches = slice.match(/(\d+(?:\.\d+)?)%/g) || [];
  const values = matches
    .map((item) => Number(item.replace('%', '')))
    .filter((value) => Number.isFinite(value));
  if (!values.length) {
    return /免(费|收)/.test(slice) ? 0 : null;
  }
  const positive = values.filter((value) => value > 0);
  if (positive.length) {
    const preferred = positive.filter((value) => value >= 0.1);
    return Math.min(...(preferred.length ? preferred : positive));
  }
  return /免(费|收)/.test(slice) || values.includes(0) ? 0 : null;
}

function extractPurchaseFee(html: string): number | null {
  if (!html) return null;
  const purchaseMatch = html.match(
    /购买手续费[\s\S]*?<b[^>]*>([\d.]+)%<\/b>\s*&nbsp;\s*<b[^>]*>([\d.]+)%<\/b>/i
  );
  if (purchaseMatch) {
    const discounted = Number(purchaseMatch[2]);
    const raw = Number(purchaseMatch[1]);
    if (Number.isFinite(discounted)) return discounted;
    if (Number.isFinite(raw)) return raw;
  }
  const singleMatch = html.match(/购买手续费[\s\S]*?<b[^>]*>([\d.]+)%<\/b>/i);
  if (singleMatch) {
    const value = Number(singleMatch[1]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function parseRateValue(value: any): number | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  const match = raw.match(/([\d.]+)%/);
  if (match && match[1]) {
    const num = Number(match[1]);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

async function getFeeRateFromTiantian(code: string): Promise<number | null> {
  const params = new URLSearchParams();
  params.set('deviceid', TT_DEVICE_ID);
  params.set('version', '9.9.9');
  params.set('appVersion', '6.5.5');
  params.set('product', 'EFund');
  params.set('plat', 'Web');
  params.set('uid', '');
  params.set('fcode', code);
  params.set('indexfields', TT_INDEX_FIELDS.replace(/^indexfields=/, ''));
  params.set('fields', TT_FIELDS.replace(/^fields=/, ''));
  params.set('fundUniqueInfo_fIELDS', TT_UNIQUE_FIELDS.replace(/^fundUniqueInfo_fIELDS=/, ''));
  params.set('fundUniqueInfo_fLFIELDS', TT_UNIQUE_FL_FIELDS.replace(/^fundUniqueInfo_fLFIELDS=/, ''));
  params.set('cfhFundFInfo_fields', TT_CFH_FIELDS.replace(/^cfhFundFInfo_fields=/, ''));
  params.set('ISRG', '0');
  params.set('relateThemeFields', TT_RELATE_FIELDS.replace(/^relateThemeFields=/, ''));

  const data = await fetchJsonPost(TT_FEE_URL, params.toString(), {
    validmark: TT_VALIDMARK
  });
  const rateInfo = data?.data?.rateInfo || null;
  const baseInfo = Array.isArray(data?.data?.baseInfo) ? data.data.baseInfo[0] : null;
  if (rateInfo?.sg && Array.isArray(rateInfo.sg) && rateInfo.sg.length) {
    const first = rateInfo.sg[0];
    const rate = parseRateValue(first?.rate);
    if (rate !== null) return rate;
  }
  const rate = parseRateValue(baseInfo?.RATE) ?? parseRateValue(baseInfo?.SOURCERATE);
  return rate;
}
