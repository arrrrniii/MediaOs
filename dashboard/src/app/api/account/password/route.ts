import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

export async function PATCH(req: NextRequest) {
  const ctx = await getAccountContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();

  try {
    const result = await accountFetch(ctx, `/api/v1/accounts/${ctx.userId}/password`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to change password';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
