import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

const API_URL = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const MASTER_KEY = process.env.MASTER_KEY || '';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const searchParams = req.nextUrl.searchParams;
  const qs = searchParams.toString();

  const res = await fetch(`${API_URL}/api/v1/projects/${id}/files/download/zip?${qs}`, {
    headers: { Authorization: `Bearer ${MASTER_KEY}` },
  });

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
