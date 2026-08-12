import { NextRequest, NextResponse } from 'next/server';
import { getAccountContext } from '@/lib/session';
import { accountFetch, accountFormDataFetch } from '@/lib/api';

// GET — list subtitle tracks for a video.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, fileId } = await params;
  try {
    const result = await accountFetch(ctx, `/api/v1/projects/${id}/files/${fileId}/subtitles`);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load subtitles';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// POST — upload a subtitle track (.vtt or .srt) as multipart form-data.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, fileId } = await params;
  const incoming = await req.formData();
  const form = new FormData();
  for (const [key, value] of incoming.entries()) form.append(key, value);

  try {
    const result = await accountFormDataFetch(
      ctx,
      `/api/v1/projects/${id}/files/${fileId}/subtitles`,
      form,
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to upload subtitle';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
