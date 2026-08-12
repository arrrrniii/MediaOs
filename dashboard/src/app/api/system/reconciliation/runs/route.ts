import { NextRequest, NextResponse } from 'next/server';
import { isSystemAdmin } from '@/lib/systemAdmin';
import { systemAdminFetch } from '@/lib/api';

// GET /api/system/reconciliation/runs — recent reconciliation runs (MASTER_KEY).
export async function GET(req: NextRequest) {
  if (!(await isSystemAdmin())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const limit = Number(req.nextUrl.searchParams.get('limit')) || 25;
  try {
    const result = await systemAdminFetch(`/api/v1/system/reconciliation/runs?limit=${limit}`);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load reconciliation runs';
    const status = err && typeof err === 'object' && 'status' in err ? Number((err as { status: number }).status) || 502 : 502;
    return NextResponse.json({ error: message, data: [] }, { status });
  }
}
