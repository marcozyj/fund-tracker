import type FuseType from 'fuse.js';

type FundFuzzyItem = {
  code: string;
  name: string;
};

const FUND_CODE_SEARCH_URL = 'https://fund.eastmoney.com/js/fundcode_search.js';
const FUND_LIST_CACHE_KEY = 'fund_fuzzy_list_v1';
const FUND_LIST_CACHE_TIME = 24 * 60 * 60 * 1000;

let fundListPromise: Promise<FundFuzzyItem[]> | null = null;
let fusePromise: Promise<FuseType<FundFuzzyItem>> | null = null;

const formatEastMoneyFundList = (rawList: unknown) => {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map((item) => {
      if (!Array.isArray(item)) return null;
      const code = String(item[0] ?? '').trim();
      const name = String(item[2] ?? '').trim();
      if (!code || !name) return null;
      return { code, name };
    })
    .filter(Boolean) as FundFuzzyItem[];
};

const loadFundListFromCache = () => {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(FUND_LIST_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { time: number; list: FundFuzzyItem[] };
    if (!parsed?.time || !Array.isArray(parsed?.list)) return null;
    if (Date.now() - parsed.time > FUND_LIST_CACHE_TIME) return null;
    return parsed.list;
  } catch {
    return null;
  }
};

const saveFundListToCache = (list: FundFuzzyItem[]) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FUND_LIST_CACHE_KEY, JSON.stringify({ time: Date.now(), list }));
  } catch {
    // ignore
  }
};

const loadFundList = async () => {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.body) return [];
  const cached = loadFundListFromCache();
  if (cached?.length) return cached;
  if (fundListPromise) return fundListPromise;

  fundListPromise = new Promise<FundFuzzyItem[]>((resolve, reject) => {
    const prevR = (window as any).r;
    const script = document.createElement('script');
    script.src = `${FUND_CODE_SEARCH_URL}?_=${Date.now()}`;
    script.async = true;

    const cleanup = () => {
      if (document.body.contains(script)) {
        document.body.removeChild(script);
      }
      if (prevR === undefined) {
        try {
          delete (window as any).r;
        } catch {
          (window as any).r = undefined;
        }
      } else {
        (window as any).r = prevR;
      }
    };

    script.onload = () => {
      const snapshot = Array.isArray((window as any).r)
        ? JSON.parse(JSON.stringify((window as any).r))
        : [];
      cleanup();
      const parsed = formatEastMoneyFundList(snapshot);
      if (!parsed.length) {
        fundListPromise = null;
        reject(new Error('PARSE_ALL_FUND_FAILED'));
        return;
      }
      saveFundListToCache(parsed);
      resolve(parsed);
    };

    script.onerror = () => {
      cleanup();
      fundListPromise = null;
      reject(new Error('LOAD_ALL_FUND_FAILED'));
    };

    document.body.appendChild(script);
  });

  return fundListPromise;
};

const getFuse = async () => {
  if (fusePromise) return fusePromise;
  fusePromise = (async () => {
    const [fuseModule, list] = await Promise.all([import('fuse.js'), loadFundList()]);
    const FuseCtor = fuseModule.default as typeof import('fuse.js').default;
    return new FuseCtor(list, {
      keys: ['name', 'code'],
      includeScore: true,
      threshold: 0.5,
      ignoreLocation: true,
      minMatchCharLength: 2
    });
  })();
  return fusePromise;
};

const normalizeFundText = (value: string) =>
  value
    .toUpperCase()
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/[·•]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^\u4e00-\u9fa5A-Z0-9()]/g, '');

const parseFundQuerySignals = (rawName: string) => {
  const normalized = normalizeFundText(rawName);
  const hasETF = normalized.includes('ETF');
  const hasLOF = normalized.includes('LOF');
  const hasLink = normalized.includes('联接');
  const shareMatch = normalized.match(/([A-Z])(?:类)?$/i);
  const shareClass = shareMatch ? shareMatch[1].toUpperCase() : null;

  const core = normalized
    .replace(/基金/g, '')
    .replace(/ETF联接/g, '')
    .replace(/联接[A-Z]?/g, '')
    .replace(/ETF/g, '')
    .replace(/LOF/g, '')
    .replace(/[A-Z](?:类)?$/g, '');

  return { normalized, core, hasETF, hasLOF, hasLink, shareClass };
};

export const resolveFundByFuzzy = async (name: string) => {
  if (!name) return null;
  const querySignals = parseFundQuerySignals(name);
  if (!querySignals.normalized) return null;

  const len = querySignals.normalized.length;
  const strictThreshold = len <= 4 ? 0.16 : len <= 8 ? 0.22 : 0.28;
  const relaxedThreshold = Math.min(0.45, strictThreshold + 0.16);
  const scoreGapThreshold = len <= 5 ? 0.08 : 0.06;

  try {
    const fuse = await getFuse();
    const recalled = fuse.search(name, { limit: 50 });
    if (!recalled.length) return null;

    const stage1 = recalled.filter((item) => (item.score ?? 1) <= relaxedThreshold);
    if (!stage1.length) return null;

    const ranked = stage1
      .map((item) => {
        const candidateSignals = parseFundQuerySignals(item?.item?.name || '');
        let finalScore = item.score ?? 1;

        if (querySignals.hasETF) finalScore += candidateSignals.hasETF ? -0.04 : 0.2;
        if (querySignals.hasLOF) finalScore += candidateSignals.hasLOF ? -0.04 : 0.2;
        if (querySignals.hasLink) finalScore += candidateSignals.hasLink ? -0.03 : 0.18;
        if (querySignals.shareClass) {
          finalScore += candidateSignals.shareClass === querySignals.shareClass ? -0.03 : 0.18;
        }

        if (querySignals.core && candidateSignals.core) {
          if (candidateSignals.core.includes(querySignals.core)) {
            finalScore -= 0.06;
          } else if (!querySignals.core.includes(candidateSignals.core)) {
            finalScore += 0.06;
          }
        }

        return { ...item, finalScore };
      })
      .sort((a, b) => a.finalScore - b.finalScore);

    const top1 = ranked[0];
    if (!top1 || top1.finalScore > strictThreshold) return null;

    const top2 = ranked[1];
    if (top2 && (top2.finalScore - top1.finalScore) < scoreGapThreshold) {
      return null;
    }

    return top1?.item || null;
  } catch {
    fusePromise = null;
    return null;
  }
};
