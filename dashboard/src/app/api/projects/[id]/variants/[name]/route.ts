import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, name } = await params;
  try {
    const result = await accountFetch(
      ctx,
      `/api/v1/projects/${id}/variants/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete variant';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
