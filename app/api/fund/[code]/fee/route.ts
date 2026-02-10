import { resolveFundCode } from '../../../../../lib/api';
import { getFundFeeRate, normalizeCode } from '../../../../../lib/fund';

export async function GET(request: Request, { params }: { params: { code?: string } }) {
  const code = normalizeCode(resolveFundCode(request, params));
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
