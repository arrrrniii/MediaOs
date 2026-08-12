import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountStreamFetch } from '@/lib/api';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  const ctx = await getAccountContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id, fileId } = await params;

  const res = await accountStreamFetch(
    ctx,
    `/api/v1/projects/${id}/files/${fileId}/download`,
  );

  if (!res.ok) {
    return NextResponse.json({ error: 'Download failed' }, { status: res.status });
  }

  return new NextResponse(res.body, {
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Disposition': res.headers.get('Content-Disposition') || 'attachment',
      'Content-Length': res.headers.get('Content-Length') || '',
    },
  });
}
