import { searchFunds } from '../../../lib/fund';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q') || '';
  const limit = Number(searchParams.get('limit') || '8');

  try {
    const results = await searchFunds(q, Number.isFinite(limit) ? limit : 8);
    return Response.json(results);
  } catch (e) {
    return Response.json([], { status: 200 });
  }
}
