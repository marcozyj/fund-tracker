import { resolveFundCode } from '../../../../../lib/api';
import { getFundPositions, getStockQuotes, normalizeCode } from '../../../../../lib/fund';

export async function GET(request: Request, { params }: { params: { code?: string } }) {
  const code = normalizeCode(resolveFundCode(request, params));
  if (!code) {
    return Response.json({ error: 'Invalid fund code' }, { status: 400 });
  }

  try {
    const data = await getFundPositions(code);
    if (!data) {
      return Response.json({ error: 'No position data available' }, { status: 404 });
    }
    const codes = data.holdings?.length ? data.holdings.map((item) => item.secid || item.code).filter(Boolean) : [];
    const quotes = codes.length ? await getStockQuotes(codes) : {};
    return Response.json({ code, ...data, quotes });
  } catch (e) {
    return Response.json({ error: 'Failed to fetch fund positions' }, { status: 500 });
  }
}
