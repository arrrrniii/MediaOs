import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

function errStatus(err: unknown, fallback: number) {
  return err && typeof err === 'object' && 'status' in err
    ? Number((err as { status: number }).status) || fallback
    : fallback;
}

// PATCH /api/storage/backends/:id — update name/status/cold-default/credentials.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  try {
    const result = await accountFetch(ctx, `/api/v1/storage/backends/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update storage backend';
    return NextResponse.json({ error: message }, { status: errStatus(err, 400) });
  }
}

// DELETE /api/storage/backends/:id — delete (blocked while it holds objects).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  try {
    const result = await accountFetch(ctx, `/api/v1/storage/backends/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete storage backend';
    return NextResponse.json({ error: message }, { status: errStatus(err, 400) });
  }
}
