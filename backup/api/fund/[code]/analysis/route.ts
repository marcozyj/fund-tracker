import { NextRequest } from 'next/server';
import { analyzeFund } from '../../../../../lib/analysis';
import { resolveFundCode } from '../../../../../lib/api';
import { getFundHistory, normalizeCode } from '../../../../../lib/fund';

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

  const { searchParams } = new URL(request.url);
  const daysParam = Number(searchParams.get('days') || '365');
  const days = Number.isFinite(daysParam) ? daysParam : 365;

  try {
    const result = await getFundHistory(code, days);
    const analysis = analyzeFund(result.history);
    if (!analysis) {
      return Response.json({ error: 'No analysis data available' }, { status: 404 });
    }

    return Response.json({
      fund_code: code,
      name: result.name || code,
      ...analysis
    });
  } catch (e) {
    return Response.json({ error: 'Failed to analyze fund' }, { status: 500 });
  }
}
