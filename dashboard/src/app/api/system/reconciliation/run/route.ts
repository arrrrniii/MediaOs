import { NextRequest, NextResponse } from 'next/server';
import { isSystemAdmin } from '@/lib/systemAdmin';
import { systemAdminFetch } from '@/lib/api';

// POST /api/system/reconciliation/run — enqueue a reconcile pass (MASTER_KEY).
export async function POST(req: NextRequest) {
  if (!(await isSystemAdmin())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  try {
    const result = await systemAdminFetch('/api/v1/system/reconciliation/run', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to start reconciliation';
    const status = err && typeof err === 'object' && 'status' in err ? Number((err as { status: number }).status) || 400 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
