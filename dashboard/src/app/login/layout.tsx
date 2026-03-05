import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

const INTERNAL_API = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export default async function LoginLayout({ children }: { children: React.ReactNode }) {
  try {
    const res = await fetch(`${INTERNAL_API}/api/v1/setup`, { cache: 'no-store' });
    const data = await res.json();
    if (data.needsSetup) redirect('/setup');
  } catch {
    // Worker not ready — show login normally
  }

  return <>{children}</>;
}
