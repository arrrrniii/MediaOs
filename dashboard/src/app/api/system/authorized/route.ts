import { NextResponse } from 'next/server';
import { isSystemAdmin } from '@/lib/systemAdmin';

// GET /api/system/authorized — whether the current user may see the System
// Health page. The sidebar uses this to decide whether to render the link.
export async function GET() {
  return NextResponse.json({ admin: await isSystemAdmin() });
}
