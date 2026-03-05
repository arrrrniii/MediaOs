import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

const INTERNAL_API = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export default async function Home() {
  // Check if setup is needed
  try {
    const res = await fetch(`${INTERNAL_API}/api/v1/setup`, { cache: 'no-store' });
    const data = await res.json();
    if (data.needsSetup) redirect('/setup');
  } catch {
    // Worker might not be ready yet — fall through to login
  }

  const session = await getServerSession(authOptions);
  if (session) {
    redirect('/dashboard');
  } else {
    redirect('/login');
  }
}
