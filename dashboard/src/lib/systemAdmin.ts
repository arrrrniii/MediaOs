import { getServerSession } from 'next-auth';
import { authOptions } from './auth';

/**
 * Whether the signed-in user may reach the system-health / reconciliation
 * pages. Those pages proxy MASTER_KEY-backed, cross-tenant worker endpoints, so
 * access is gated to a single configured operator email (ADMIN_EMAIL — the same
 * value the installer sets for the initial admin), NOT to any account owner.
 *
 * Tradeoff (documented): this is a coarse allowlist, not a per-user permission
 * model. Anyone whose session email equals ADMIN_EMAIL sees install-wide health.
 * When ADMIN_EMAIL is unset we deny everyone rather than fall back to "any
 * account owner", because that fallback would expose one tenant's owner to every
 * other tenant's data through the MASTER_KEY proxy.
 */
export async function isSystemAdmin(): Promise<boolean> {
  const configured = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  if (!configured) return false;

  const session = await getServerSession(authOptions);
  const email = session?.user?.email?.toLowerCase().trim();
  if (!email) return false;

  return email === configured;
}
