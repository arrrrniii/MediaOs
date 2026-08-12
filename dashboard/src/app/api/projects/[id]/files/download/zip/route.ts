import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountStreamFetch } from '@/lib/api';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getAccountContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const qs = req.nextUrl.searchParams.toString();

  const res = await accountStreamFetch(
    ctx,
    `/api/v1/projects/${id}/files/download/zip?${qs}`,
  );

  if (!res.ok) {
    return NextResponse.json({ error: 'Download failed' }, { status: res.status });
  }

  return new NextResponse(res.body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': res.headers.get('Content-Disposition') || 'attachment; filename="mediaos-files.zip"',
    },
  });
}
