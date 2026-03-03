import { NextRequest } from 'next/server';
import { resolveFundCode } from '../../../../../lib/api';
import { getFundFeeRate, normalizeCode } from '../../../../../lib/fund';

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
    const feeRate = await getFundFeeRate(code, true);
    return Response.json({ code, feeRate });
  } catch (e) {
    return Response.json({ error: 'Failed to fetch fee rate' }, { status: 500 });
  }
}
