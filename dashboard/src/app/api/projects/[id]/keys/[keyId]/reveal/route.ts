import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; keyId: string }> },
) {
  const ctx = await getAccountContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id, keyId } = await params;
  try {
    const result = await accountFetch(ctx, `/api/v1/projects/${id}/keys/${keyId}/reveal`, {
      method: 'POST',
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Key not available';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
