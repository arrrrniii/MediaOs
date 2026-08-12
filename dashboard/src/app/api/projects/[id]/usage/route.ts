import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getAccountContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const days = req.nextUrl.searchParams.get('days') || '30';

  try {
    const [usage, history] = await Promise.all([
      accountFetch(ctx, `/api/v1/projects/${id}/usage`).catch(() => null),
      accountFetch(ctx, `/api/v1/projects/${id}/usage/history?days=${days}`).catch(() => null),
    ]);
    if (!usage && !history) {
      return NextResponse.json(
        { error: 'Usage data unavailable', usage: null, history: null },
        { status: 502 },
      );
    }
    return NextResponse.json({ usage, history });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch usage';
    return NextResponse.json({ error: message, usage: null, history: null }, { status: 502 });
  }
}
