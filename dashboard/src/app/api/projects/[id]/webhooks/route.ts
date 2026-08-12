import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getAccountContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  try {
    const result = await accountFetch(ctx, `/api/v1/projects/${id}/webhooks`);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch webhooks';
    return NextResponse.json({ error: message, data: [] }, { status: 502 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getAccountContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json();

  try {
    const result = await accountFetch(ctx, `/api/v1/projects/${id}/webhooks`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create webhook';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
