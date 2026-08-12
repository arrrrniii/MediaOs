import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

export async function GET(req: NextRequest) {
  const ctx = await getAccountContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const status = req.nextUrl.searchParams.get('status');
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';

  try {
    const result = await accountFetch(ctx, `/api/v1/lifecycle/notifications${qs}`);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load notifications';
    return NextResponse.json({ error: message, data: [], unread_count: 0 }, { status: 502 });
  }
}
