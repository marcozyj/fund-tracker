import { backtestMovingAverage } from '../../../../../../lib/analysis';
import { resolveFundCode } from '../../../../../../lib/api';
import { getFundHistory, normalizeCode } from '../../../../../../lib/fund';

export async function GET(request: Request, { params }: { params: { code?: string } }) {
  const code = normalizeCode(resolveFundCode(request, params));
  if (!code) {
    return Response.json({ error: 'Invalid fund code' }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const daysParam = Number(searchParams.get('days') || '365');
  const days = Number.isFinite(daysParam) ? daysParam : 365;

  try {
    const result = await getFundHistory(code, days);
    const backtest = backtestMovingAverage(result.history);
    if (!backtest) {
      return Response.json({ error: 'Insufficient data for backtesting' }, { status: 400 });
    }

    return Response.json({
      fund_code: code,
      name: result.name || code,
      ...backtest
    });
  } catch (e) {
    return Response.json({ error: 'Failed to backtest fund' }, { status: 500 });
  }
}
