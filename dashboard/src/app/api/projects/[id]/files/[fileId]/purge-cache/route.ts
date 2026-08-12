import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, fileId } = await params;
  try {
    const result = await accountFetch(
      ctx,
      `/api/v1/projects/${id}/files/${fileId}/purge-cache`,
      { method: 'POST' },
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to purge cache';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
