import { NextRequest } from 'next/server';
import { resolveFundCode } from '../../../../../lib/api';
import { getFundPerformance, normalizeCode } from '../../../../../lib/fund';

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
  try {
    const period = searchParams.get('period');
    const performance = await getFundPerformance(code, period);
    if (!performance) {
      return Response.json({ error: 'No performance data available' }, { status: 404 });
    }

    return Response.json({ fund_code: code, ...performance });
  } catch (e) {
    return Response.json({ error: 'Failed to fetch performance data' }, { status: 500 });
  }
}
