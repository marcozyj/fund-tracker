import { NextRequest } from 'next/server';
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
    return Response.json({
      code,
      name: result.name || '',
      history: result.history
    });
  } catch (e) {
    return Response.json({ error: 'Failed to fetch fund history' }, { status: 500 });
  }
}
