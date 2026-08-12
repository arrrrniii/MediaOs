import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const ctx = await getAccountContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { jobId } = await params;

  try {
    // The worker scopes the retry to the caller's account via the job's
    // file → project → account chain; a cross-tenant jobId comes back 404.
    const result = await accountFetch(ctx, `/api/v1/jobs/${encodeURIComponent(jobId)}/retry`, {
      method: 'POST',
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to retry job';
    const status = err && typeof err === 'object' && 'status' in err
      ? Number((err as { status: number }).status) || 400
      : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
