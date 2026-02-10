import { NextRequest } from 'next/server';
import { getFundHistory, normalizeCode } from '../../../lib/fund';

export const dynamic = 'force-static';

const PERIOD_OFFSETS: Record<string, number> = {
  week: 5,
  month: 22,
  quarter: 66,
  year: 252
};

export async function GET(
  request: NextRequest,
  _context: { params: Promise<Record<string, string>> }
) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get('period') || 'month';
  const limitParam = Number(searchParams.get('limit') || '10');
  const limit = Number.isFinite(limitParam) ? limitParam : 10;
  const codesParam = searchParams.get('codes') || '';

  const offset = PERIOD_OFFSETS[period] || PERIOD_OFFSETS.month;
  const codes = codesParam
    .split(',')
    .map((code) => normalizeCode(code))
    .filter(Boolean);

  if (!codes.length) {
    return Response.json([]);
  }

  try {
    const results = await Promise.all(
      codes.map(async (code) => {
        const historyResult = await getFundHistory(code, offset + 10);
        const history = historyResult.history;
        if (history.length <= offset) return null;
        const last = history[history.length - 1].nav;
        const prev = history[history.length - 1 - offset].nav;
        const ret = prev ? ((last - prev) / prev) * 100 : 0;
        return {
          fund_code: code,
          fund_name: historyResult.name || code,
          return: Number(ret.toFixed(2))
        };
      })
    );

    return Response.json(
      results
        .filter(Boolean)
        .sort((a, b) => (b!.return ?? 0) - (a!.return ?? 0))
        .slice(0, limit)
    );
  } catch (e) {
    return Response.json([], { status: 200 });
  }
}
