import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, fileId } = await params;
  const qs = req.nextUrl.searchParams.toString();
  try {
    const result = await accountFetch(
      ctx,
      `/api/v1/projects/${id}/files/${fileId}/hls-url${qs ? `?${qs}` : ''}`,
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load playback info';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
