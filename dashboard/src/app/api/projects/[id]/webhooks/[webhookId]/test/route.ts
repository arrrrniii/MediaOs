import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; webhookId: string }> },
) {
  const ctx = await getAccountContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id, webhookId } = await params;
  try {
    const result = await accountFetch(ctx, 
      `/api/v1/projects/${id}/webhooks/${webhookId}/test`,
      { method: 'POST' },
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Test endpoint not available';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
