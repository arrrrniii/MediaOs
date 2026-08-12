import { NextResponse } from 'next/server';
import { isSystemAdmin } from '@/lib/systemAdmin';
import { systemAdminFetch } from '@/lib/api';

// GET /api/system/health — proxy the worker's install-wide health (MASTER_KEY).
export async function GET() {
  if (!(await isSystemAdmin())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const result = await systemAdminFetch('/api/v1/system/health');
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load system health';
    const status = err && typeof err === 'object' && 'status' in err ? Number((err as { status: number }).status) || 502 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
