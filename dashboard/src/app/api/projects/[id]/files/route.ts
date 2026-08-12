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
  const searchParams = req.nextUrl.searchParams;
  const qs = searchParams.toString();

  try {
    const result = await accountFetch(ctx, `/api/v1/projects/${id}/files?${qs}`);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch files';
    return NextResponse.json({ error: message, data: [], total: 0 }, { status: 502 });
  }
}
