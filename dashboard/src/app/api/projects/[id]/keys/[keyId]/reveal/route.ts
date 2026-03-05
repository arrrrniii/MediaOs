import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { adminFetch } from '@/lib/api';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; keyId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id, keyId } = await params;
  try {
    const result = await adminFetch(`/api/v1/projects/${id}/keys/${keyId}/reveal`, {
      method: 'POST',
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Key not available';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
