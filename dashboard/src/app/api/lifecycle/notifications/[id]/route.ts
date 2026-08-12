import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

// POST body: { action: 'read' | 'dismiss' }
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getAccountContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action = body.action === 'dismiss' ? 'dismiss' : 'read';

  try {
    const result = await accountFetch(
      ctx,
      `/api/v1/lifecycle/notifications/${encodeURIComponent(id)}/${action}`,
      { method: 'POST' },
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update notification';
    const status = err && typeof err === 'object' && 'status' in err
      ? Number((err as { status: number }).status) || 400
      : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
