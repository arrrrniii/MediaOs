import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

// GET /api/storage/backends — list the account's storage backends (redacted).
export async function GET() {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const result = await accountFetch(ctx, '/api/v1/storage/backends');
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load storage backends';
    const status = err && typeof err === 'object' && 'status' in err ? Number((err as { status: number }).status) || 502 : 502;
    return NextResponse.json({ error: message, data: [] }, { status });
  }
}

// POST /api/storage/backends — create a backend (credentials encrypted server-side).
export async function POST(req: NextRequest) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  try {
    const result = await accountFetch(ctx, '/api/v1/storage/backends', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create storage backend';
    const status = err && typeof err === 'object' && 'status' in err ? Number((err as { status: number }).status) || 400 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
