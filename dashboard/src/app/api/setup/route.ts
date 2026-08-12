import { NextResponse } from 'next/server';
import { clientIpHeaders } from '@/lib/api';

const INTERNAL_API = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

// First-boot only: the worker refuses this once any account exists, and rate
// limits it by IP — hence forwarding the caller's address rather than ours.
export async function GET() {
  try {
    const res = await fetch(`${INTERNAL_API}/api/v1/setup`, {
      headers: await clientIpHeaders(),
      cache: 'no-store',
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ needsSetup: false });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const res = await fetch(`${INTERNAL_API}/api/v1/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await clientIpHeaders()) },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Setup failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
