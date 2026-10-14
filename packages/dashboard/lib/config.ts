/** Server-side configuration, read lazily so `next build` works without runtime secrets. */
export type DashboardUser =
  { role: 'platform_admin' } | { role: 'tenant_admin' | 'finance_viewer'; tenant: string };

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const config = {
  gatewayUrl: () => (process.env.GATEWAY_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  adminJwtSecret: () => required('ADMIN_JWT_SECRET'),
  /** Tenant shown by the credential-free demo login; unset disables it. */
  demoTenantId: () => process.env.DEMO_TENANT_ID || undefined,
  github: () =>
    process.env.GITHUB_ID && process.env.GITHUB_SECRET
      ? { clientId: process.env.GITHUB_ID, clientSecret: process.env.GITHUB_SECRET }
      : undefined,
  /** Email allow-list: {"owner@example.com":{"role":"platform_admin"}, "cfo@acme.com":{"role":"finance_viewer","tenant":"<uuid>"}} */
  users: (): Record<string, DashboardUser> => {
    const raw = process.env.DASHBOARD_USERS;
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, DashboardUser>;
    return Object.fromEntries(
      Object.entries(parsed).map(([email, user]) => [email.toLowerCase(), user]),
    );
  },
};
