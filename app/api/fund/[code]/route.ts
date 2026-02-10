import { NextRequest } from 'next/server';
import { resolveFundCode } from '../../../../lib/api';
import { getFundBasic, getFundFeeRate, getFundHistory, normalizeCode } from '../../../../lib/fund';

export const dynamic = 'force-static';
export const dynamicParams = false;

export async function generateStaticParams() {
  return [];
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code: rawCode } = await params;
  const code = normalizeCode(resolveFundCode(request, { code: rawCode }));
  if (!code) {
    return Response.json({ error: 'Invalid fund code' }, { status: 400 });
  }

  try {
    const [basic, history] = await Promise.all([
      getFundBasic(code),
      getFundHistory(code, 30)
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
    const latestNav = latestPoint?.nav ?? null;
    const latestDate = latestPoint?.date || '';
    const estPct = latestPoint?.daily_growth_rate ?? null;

    return Response.json({
      code,
      name: history?.name || basic?.name || code,
      type: basic?.type || '',
      latestNav,
      latestDate,
      estNav: latestNav,
      estPct,
      updateTime: latestDate,
      feeRate
    });
  } catch (e) {
    return Response.json({ error: 'Failed to fetch fund data' }, { status: 500 });
  }
}
