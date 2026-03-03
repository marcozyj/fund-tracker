import { NextRequest } from 'next/server';
import { resolveFundCode } from '../../../../../lib/api';
import { getFundHistoryTable, normalizeCode } from '../../../../../lib/fund';

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
  const pageParam = Number(searchParams.get('page') || '1');
  const perParam = Number(searchParams.get('per') || '49');
  const page = Number.isFinite(pageParam) ? pageParam : 1;
  const per = Number.isFinite(perParam) ? perParam : 49;

  try {
    const data = await getFundHistoryTable(code, page, per);
    if (!data) {
      return Response.json({ error: 'No history table data available' }, { status: 404 });
    }
    return Response.json({ code, ...data });
  } catch (e) {
    return Response.json({ error: 'Failed to fetch history table' }, { status: 500 });
  }
}
