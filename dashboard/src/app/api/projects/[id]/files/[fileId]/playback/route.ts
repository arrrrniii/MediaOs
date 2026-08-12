import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

// POST — record a playback event (lightweight beacon from the player).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, fileId } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    const result = await accountFetch(
      ctx,
      `/api/v1/projects/${id}/files/${fileId}/playback`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to record event';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
