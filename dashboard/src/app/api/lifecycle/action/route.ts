import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';

// POST body: { projectId, fileId, action }
export async function POST(req: NextRequest) {
  const ctx = await getAccountContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { projectId, fileId, action } = body || {};
  if (!projectId || !fileId || !action) {
    return NextResponse.json(
      { error: 'projectId, fileId and action are required' },
      { status: 400 },
    );
  }

  try {
    // The worker enforces role + tenant scoping; a cross-tenant project 404s.
    const result = await accountFetch(
      ctx,
      `/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/lifecycle`,
      { method: 'POST', body: JSON.stringify({ action }) },
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to apply lifecycle action';
    const status = err && typeof err === 'object' && 'status' in err
      ? Number((err as { status: number }).status) || 400
      : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
