import { NextRequest } from 'next/server';
import { searchFunds } from '../../../lib/fund';

export const dynamic = 'force-static';

export async function GET(
  request: NextRequest,
  _context: { params: Promise<Record<string, string>> }
) {
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
