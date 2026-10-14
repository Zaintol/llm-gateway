import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { KpiRow } from '@/components/KpiRow';
import { RangePicker } from '@/components/RangePicker';
import { SignOutButton } from '@/components/SessionButtons';
import { SpendChart } from '@/components/SpendChart';
import { TenantTable } from '@/components/TenantTable';
import { AdminApiError, adminGet } from '@/lib/admin';
import { authOptions, type Principal } from '@/lib/auth';
import { buildOverview, type Overview, type UsageRow } from '@/lib/overview';
import { parseRange, type Range } from '@/lib/range';

export const dynamic = 'force-dynamic';

const ROLE_LABEL = {
  platform_admin: 'Platform admin',
  tenant_admin: 'Tenant admin',
  finance_viewer: 'Finance viewer',
} as const;

async function loadOverview(principal: Principal, range: Range): Promise<Overview> {
  const q = (from: Date, to: Date, groupBy: string) =>
    `/usage?from=${from.toISOString()}&to=${to.toISOString()}&group_by=${groupBy}`;
  // The admin API scopes tenant roles to their own tenant, so these never include other tenants.
  const [current, previous, byTenant, tenants, models] = await Promise.all([
    adminGet<{ data: UsageRow[] }>(principal, q(range.from, range.to, `${range.bucket},model`)),
    adminGet<{ data: UsageRow[] }>(principal, q(range.prevFrom, range.from, 'model')),
    adminGet<{ data: UsageRow[] }>(principal, q(range.from, range.to, 'tenant')),
    principal.role === 'platform_admin'
      ? adminGet<{ data: Array<{ id: string; name: string }> }>(principal, '/tenants')
      : adminGet<{ id: string; name: string }>(principal, `/tenants/${principal.tenantId}`).then(
          (t) => ({ data: [t] }),
        ),
    adminGet<{ data: Array<{ id: string }> }>(principal, '/models'),
  ]);
  return buildOverview({
    range,
    current: current.data,
    previous: previous.data,
    byTenant: byTenant.data,
    tenantNames: Object.fromEntries(tenants.data.map((t) => [t.id, t.name])),
    catalogOrder: models.data.map((m) => m.id),
  });
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getServerSession(authOptions());
  if (!session?.principal) redirect('/login');
  const principal = session.principal;
  const { range, error } = parseRange(await searchParams);

  let overview: Overview | null = null;
  let loadError: string | null = null;
  try {
    overview = await loadOverview(principal, range);
  } catch (err) {
    loadError = err instanceof AdminApiError ? err.message : 'The gateway could not be reached.';
  }

  return (
    <>
      <header className="topbar">
        <span className="brand">LLM gateway</span>
        <span className="who">
          {principal.demo && <span className="badge">Read-only demo</span>}
          <span className="muted">{principal.demo ? 'Demo viewer' : principal.email}</span>
          <span className="role">{ROLE_LABEL[principal.role]}</span>
          <SignOutButton />
        </span>
      </header>
      <main className="page">
        <h1>Spend overview</h1>
        <RangePicker range={range} />
        {error && <p className="error">{error}</p>}
        {loadError && <p className="error">Could not load usage: {loadError}</p>}
        {overview && (
          <>
            <KpiRow overview={overview} periodLabel={range.label} />
            <section className="card" aria-labelledby="by-model">
              <h2 id="by-model">Spend by model</h2>
              <p className="muted small">
                {range.label}, per {range.bucket} (UTC). Top 5 models; the rest are grouped as
                Other.
              </p>
              <SpendChart
                series={overview.series}
                buckets={overview.buckets}
                bucket={range.bucket}
              />
            </section>
            <section className="card" aria-labelledby="by-tenant">
              <h2 id="by-tenant">Spend by tenant</h2>
              <TenantTable rows={overview.tenants} />
            </section>
          </>
        )}
      </main>
    </>
  );
}
