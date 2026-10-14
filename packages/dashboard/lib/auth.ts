import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GitHubProvider from 'next-auth/providers/github';
import { config } from './config';

export type Role = 'platform_admin' | 'tenant_admin' | 'finance_viewer';

/** What the dashboard knows about the signed-in person; drives the admin JWT it mints. */
export type Principal = { email: string; role: Role; tenantId: string | null; demo: boolean };

declare module 'next-auth' {
  interface Session {
    principal: Principal;
  }
}
declare module 'next-auth/jwt' {
  interface JWT {
    principal?: Principal;
  }
}

export const DEMO_EMAIL = 'demo@llm-gateway.dev';

export function authOptions(): NextAuthOptions {
  const github = config.github();
  const demoTenant = config.demoTenantId();
  return {
    pages: { signIn: '/login' },
    session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },
    providers: [
      ...(github ? [GitHubProvider(github)] : []),
      ...(demoTenant
        ? [
            CredentialsProvider({
              id: 'demo',
              name: 'Read-only demo',
              credentials: {},
              // No credentials: anyone can look around the seeded demo tenant, read-only.
              authorize: async () => ({ id: 'demo', email: DEMO_EMAIL, name: 'Demo viewer' }),
            }),
          ]
        : []),
    ],
    callbacks: {
      // GitHub sign-ins must be on the allow-list; nobody else gets a session.
      signIn: async ({ user, account }) => {
        if (account?.provider === 'demo') return true;
        return Boolean(user.email && config.users()[user.email.toLowerCase()]);
      },
      jwt: async ({ token, user, account }) => {
        if (!user || !account) return token;
        if (account.provider === 'demo') {
          token.principal = {
            email: DEMO_EMAIL,
            role: 'finance_viewer',
            tenantId: demoTenant ?? null,
            demo: true,
          };
        } else {
          const entry = config.users()[user.email!.toLowerCase()]!;
          token.principal = {
            email: user.email!,
            role: entry.role,
            tenantId: entry.role === 'platform_admin' ? null : entry.tenant,
            demo: false,
          };
        }
        return token;
      },
      session: async ({ session, token }) => ({ ...session, principal: token.principal! }),
    },
  };
}
