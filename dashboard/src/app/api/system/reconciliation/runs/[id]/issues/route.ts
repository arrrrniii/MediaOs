import { NextRequest, NextResponse } from 'next/server';
import { isSystemAdmin } from '@/lib/systemAdmin';
import { systemAdminFetch } from '@/lib/api';

// GET /api/system/reconciliation/runs/[id]/issues — issues for one run.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isSystemAdmin())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { id } = await params;
  try {
    const result = await systemAdminFetch(`/api/v1/system/reconciliation/runs/${id}/issues`);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load issues';
    const status = err && typeof err === 'object' && 'status' in err ? Number((err as { status: number }).status) || 502 : 502;
    return NextResponse.json({ error: message, data: [] }, { status });
  }
}
