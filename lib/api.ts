export function resolveFundCode(request: Request, params?: { code?: string }) {
  const direct = params?.code || '';
  if (direct) return direct;
  const path = new URL(request.url).pathname;
  const match = path.match(/\/api\/fund\/([^/]+)/);
  return match?.[1] || '';
}
