import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

export async function GET(req: NextRequest) {
  const ctx = await getAccountContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const page = req.nextUrl.searchParams.get('page') || '1';
  const limit = req.nextUrl.searchParams.get('limit') || '25';

  try {
    const result = await accountFetch(
      ctx,
      `/api/v1/lifecycle/inbox?page=${encodeURIComponent(page)}&limit=${encodeURIComponent(limit)}`,
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load lifecycle inbox';
    return NextResponse.json({ error: message, data: [], total: 0 }, { status: 502 });
  }
}
