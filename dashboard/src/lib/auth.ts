import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { internalFetch } from './api';
import type { AccountMembership } from './types';

interface LoginResponse {
  user: { id: string; name: string; email: string };
  accounts: AccountMembership[];
}

// The account a user lands in by default: one they own if there is one,
// otherwise the first membership the worker returned.
function pickActiveAccount(accounts: AccountMembership[]): AccountMembership | undefined {
  return accounts.find((a) => a.role === 'owner') || accounts[0];
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        try {
          const result = await internalFetch<LoginResponse>('/api/v1/auth/login', {
            method: 'POST',
            body: JSON.stringify({
              email: credentials.email,
              password: credentials.password,
            }),
          });

          const active = pickActiveAccount(result.accounts);

          return {
            id: result.user.id,
            name: result.user.name,
            email: result.user.email,
            accounts: result.accounts,
            activeAccountId: active?.id,
            role: active?.role,
          };
        } catch {
          return null;
        }
      },
    }),
  ],
  session: {
    strategy: 'jwt',
    maxAge: 24 * 60 * 60,
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const u = user as {
          id: string;
          accounts?: AccountMembership[];
          activeAccountId?: string;
          role?: string;
        };
        token.id = u.id;
        token.accounts = u.accounts || [];
        token.activeAccountId = u.activeAccountId;
        token.role = u.role;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        const u = session.user as {
          id?: string;
          accounts?: AccountMembership[];
          activeAccountId?: string;
          role?: string;
        };
        u.id = token.id as string;
        u.accounts = (token.accounts as AccountMembership[]) || [];
        u.activeAccountId = token.activeAccountId as string | undefined;
        u.role = token.role as string | undefined;
      }
      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
};
