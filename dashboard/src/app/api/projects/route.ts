import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

export async function POST(req: NextRequest) {
  const ctx = await getAccountContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // The worker derives the owning account from the session, so drop any
  // account_id the browser sent rather than forwarding a rejected claim.
  const body = await req.json();
  delete body.account_id;

  try {
    const result = await accountFetch(ctx, '/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create project';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
