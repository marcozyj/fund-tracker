import { resolveFundCode } from '../../../../lib/api';
import { getFundBasic, getFundFeeRate, getFundHistory, normalizeCode } from '../../../../lib/fund';

async function fetchFundGz(code: string) {
  const url = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    const match = text.match(/jsonpgz\((.*)\);?/);
    if (!match) return null;
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export async function GET(request: Request, { params }: { params: { code?: string } }) {
  const code = normalizeCode(resolveFundCode(request, params));
  if (!code) {
    return Response.json({ error: 'Invalid fund code' }, { status: 400 });
  }

  try {
    const [basic, history, gz] = await Promise.all([
      getFundBasic(code),
      getFundHistory(code, 30),
      fetchFundGz(code)
    ]);
    let feeRate: number | null = null;
    try {
      feeRate = await getFundFeeRate(code);
    } catch {
      feeRate = null;
    }

    if (!history) {
      return Response.json({ error: 'Fund not found' }, { status: 404 });
    }

    const latestPoint = history.history.length ? history.history[history.history.length - 1] : null;
    let latestNav = latestPoint?.nav ?? null;
    let latestDate = latestPoint?.date || '';
    let estNav: number | null = latestNav;
    let estPct: number | null = latestPoint?.daily_growth_rate ?? null;
    let updateTime = latestDate;

    if (gz && typeof gz === 'object') {
      const nav = Number(gz.dwjz);
      if (Number.isFinite(nav)) latestNav = nav;
      if (gz.jzrq) latestDate = String(gz.jzrq);
      const gsz = Number(gz.gsz);
      if (Number.isFinite(gsz)) estNav = gsz;
      const gszzl = Number(gz.gszzl);
      if (Number.isFinite(gszzl)) estPct = gszzl;
      updateTime = gz.gztime || latestDate || updateTime;
    }

    return Response.json({
      code,
      name: gz?.name || history?.name || basic?.name || code,
      type: basic?.type || '',
      latestNav,
      latestDate,
      estNav,
      estPct,
      updateTime,
      feeRate
    });
  } catch (e) {
    return Response.json({ error: 'Failed to fetch fund data' }, { status: 500 });
  }
}
