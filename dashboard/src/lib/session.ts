import { getServerSession } from 'next-auth';
import { authOptions } from './auth';
import type { AccountMembership } from './types';

/**
 * Everything a worker call needs to identify the caller: who they are and
 * which of their accounts they are acting on.
 */
export interface AccountContext {
  userId: string;
  accountId: string;
  role: string;
  accounts: AccountMembership[];
}

/**
 * Resolve the signed-in user's active account from the session cookie.
 * Returns null when unauthenticated or when the session predates
 * memberships (an old cookie), in which case the caller answers 401.
 */
export async function getAccountContext(): Promise<AccountContext | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;

  const user = session.user as {
    id?: string;
    activeAccountId?: string;
    role?: string;
    accounts?: AccountMembership[];
  };

  if (!user.id || !user.activeAccountId) return null;

  return {
    userId: user.id,
    accountId: user.activeAccountId,
    role: user.role || 'viewer',
    accounts: user.accounts || [],
  };
}
