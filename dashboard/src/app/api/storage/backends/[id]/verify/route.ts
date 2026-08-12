import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

// POST /api/storage/backends/:id/verify — probe connectivity.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  try {
    const result = await accountFetch(ctx, `/api/v1/storage/backends/${encodeURIComponent(id)}/verify`, {
      method: 'POST',
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Verification failed';
    const status = err && typeof err === 'object' && 'status' in err ? Number((err as { status: number }).status) || 400 : 400;
    return NextResponse.json({ error: message, verified: false }, { status });
  }
}
