import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { ModelCatalog } from '../catalog/catalog.js';
import { microsToUsd } from '../catalog/catalog.js';
import type { KeyProvider } from '../credentials/key-provider.js';
import { listCredentials, setCredential } from '../credentials/service.js';
import type { Db } from '../db/client.js';
import { budgets, tenants } from '../db/schema.js';
import { GatewayError } from '../errors.js';
import {
  createApiKey,
  createTenant,
  listApiKeys,
  revokeApiKey,
  setBudget,
  setRateLimits,
  type Actor,
  type AdminRole,
} from '../tenancy/service.js';
import { ADMIN_ROLES, type AdminAuthenticator, type AdminPrincipal } from './auth.js';
import { publishBudgetChange, publishCredentialChange } from './invalidation.js';
import { MAX_RANGE_DAYS, queryUsage, toCsv, usageQuerySchema } from './usage.js';

declare module 'fastify' {
  interface FastifyRequest {
    admin: AdminPrincipal | null;
  }
}

export type AdminDeps = {
  db: Db;
  redis: Redis;
  keys: KeyProvider;
  catalog: ModelCatalog;
  authenticator: AdminAuthenticator;
};

type Ctx<P, B, Q> = {
  params: P;
  body: B;
  query: Q;
  principal: AdminPrincipal;
  actor: Actor;
  reply: FastifyReply;
  request: FastifyRequest;
};

/** One admin endpoint: drives route registration, authorisation and the OpenAPI document. */
export type AdminRoute = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  summary: string;
  roles: readonly AdminRole[];
  params?: z.ZodObject;
  body?: z.ZodType;
  query?: z.ZodType;
  response?: z.ZodType;
  /** 201 for creations; 200 otherwise. */
  status?: number;
  handler: (ctx: Ctx<any, any, any>) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

const ALL = ADMIN_ROLES;
const MANAGERS = ['platform_admin', 'tenant_admin'] as const;
const PLATFORM = ['platform_admin'] as const;

const tenantParams = z.object({ id: z.uuid() });
const usd = z.number().min(0).max(1_000_000_000);
const toMicros = (v: number | null | undefined) =>
  v === undefined ? undefined : v === null ? null : BigInt(Math.round(v * 1_000_000));

const tenantSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(['active', 'suspended']),
  rpm_limit: z.number().nullable(),
  tpm_limit: z.number().nullable(),
  created_at: z.string(),
});
const tenantJson = (t: typeof tenants.$inferSelect) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  status: t.status,
  rpm_limit: t.rpmLimit,
  tpm_limit: t.tpmLimit,
  created_at: t.createdAt.toISOString(),
});

const budgetSchema = z.object({
  period: z.enum(['daily', 'monthly']),
  hard_limit_usd: z.number().nullable(),
  soft_limit_usd: z.number().nullable(),
});

export function adminRoutes(deps: AdminDeps): AdminRoute[] {
  const { db, redis } = deps;
  return [
    {
      method: 'GET',
      url: '/me',
      summary: 'The authenticated admin principal',
      roles: ALL,
      response: z.object({
        subject: z.string(),
        role: z.enum(ADMIN_ROLES),
        tenant_id: z.string().nullable(),
      }),
      handler: async ({ principal }) => ({
        subject: principal.subject,
        role: principal.role,
        tenant_id: principal.tenantId,
      }),
    },
    {
      method: 'GET',
      url: '/tenants',
      summary: 'List tenants (platform admins only)',
      roles: PLATFORM,
      response: z.object({ data: z.array(tenantSchema) }),
      handler: async () => ({
        data: (await db.select().from(tenants).orderBy(tenants.slug)).map(tenantJson),
      }),
    },
    {
      method: 'POST',
      url: '/tenants',
      summary: 'Create a tenant (platform admins only)',
      roles: PLATFORM,
      status: 201,
      body: z.object({
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
        name: z.string().min(1).max(200),
      }),
      response: tenantSchema,
      handler: async ({ body, actor }) => tenantJson(await createTenant(db, body, actor)),
    },
    {
      method: 'GET',
      url: '/tenants/:id',
      summary: 'Get a tenant',
      roles: ALL,
      params: tenantParams,
      response: tenantSchema,
      handler: async ({ params }) => {
        const [tenant] = await db.select().from(tenants).where(eq(tenants.id, params.id));
        if (!tenant) throw new GatewayError(404, 'not_found', 'tenant_not_found', 'No such tenant');
        return tenantJson(tenant);
      },
    },
    {
      method: 'GET',
      url: '/tenants/:id/keys',
      summary: "List a tenant's API keys (prefix and metadata only)",
      roles: MANAGERS,
      params: tenantParams,
      handler: async ({ params }) => ({
        data: (await listApiKeys(db, params.id)).map((k) => ({
          id: k.id,
          name: k.name,
          prefix: k.prefix,
          created_by: k.createdBy,
          created_at: k.createdAt.toISOString(),
          last_used_at: k.lastUsedAt?.toISOString() ?? null,
          expires_at: k.expiresAt?.toISOString() ?? null,
          revoked_at: k.revokedAt?.toISOString() ?? null,
        })),
      }),
    },
    {
      method: 'POST',
      url: '/tenants/:id/keys',
      summary: 'Create an API key; the full key is returned once',
      roles: MANAGERS,
      status: 201,
      params: tenantParams,
      body: z.object({
        name: z.string().min(1).max(100),
        expires_at: z.iso.datetime({ offset: true }).optional(),
      }),
      handler: async ({ params, body, actor }) => {
        const created = await createApiKey(
          db,
          {
            tenantId: params.id,
            name: body.name,
            expiresAt: body.expires_at ? new Date(body.expires_at) : null,
          },
          actor,
        );
        return { id: created.id, name: created.name, prefix: created.prefix, key: created.key };
      },
    },
    {
      method: 'DELETE',
      url: '/tenants/:id/keys/:prefix',
      summary: 'Revoke an API key',
      roles: MANAGERS,
      params: z.object({ id: z.uuid(), prefix: z.string().regex(/^[0-9A-Za-z]{8}$/) }),
      handler: async ({ params, actor }) => {
        await revokeApiKey(db, redis, { tenantId: params.id, prefix: params.prefix }, actor);
        return { revoked: params.prefix };
      },
    },
    {
      method: 'GET',
      url: '/tenants/:id/credentials',
      summary: 'List provider credentials (label and last 4 characters only)',
      roles: MANAGERS,
      params: tenantParams,
      handler: async ({ params }) => ({
        data: (await listCredentials(db, params.id)).map((c) => ({
          provider: c.provider,
          label: c.label,
          last4: c.last4,
          scope: c.scope,
          base_url: c.baseUrl,
        })),
      }),
    },
    {
      method: 'PUT',
      url: '/tenants/:id/credentials/:provider',
      summary: 'Store a provider credential, encrypted at rest',
      roles: MANAGERS,
      params: z.object({ id: z.uuid(), provider: z.string().regex(/^[a-z0-9-]+$/) }),
      body: z.object({
        label: z.string().min(1).max(100),
        secret: z.string().min(8).max(4096),
        base_url: z.url().optional(),
      }),
      handler: async ({ params, body, actor }) => {
        const { last4 } = await setCredential(
          db,
          deps.keys,
          {
            tenantId: params.id,
            provider: params.provider,
            label: body.label,
            secret: body.secret,
            baseUrl: body.base_url ?? null,
          },
          actor,
        );
        await publishCredentialChange(redis, params.id, params.provider);
        return { provider: params.provider, label: body.label, last4 };
      },
    },
    {
      method: 'GET',
      url: '/tenants/:id/budgets',
      summary: "A tenant's daily and monthly budgets",
      roles: ALL,
      params: tenantParams,
      response: z.object({ data: z.array(budgetSchema) }),
      handler: async ({ params }) => {
        const rows = await db.select().from(budgets).where(eq(budgets.tenantId, params.id));
        return {
          data: rows
            .filter((b) => b.apiKeyId === null)
            .map((b) => ({
              period: b.period,
              hard_limit_usd: microsToUsd(b.hardLimitMicros),
              soft_limit_usd: microsToUsd(b.softLimitMicros),
            })),
        };
      },
    },
    {
      method: 'PUT',
      url: '/tenants/:id/budgets',
      summary: 'Set a daily or monthly budget (null removes a limit); applies to the next request',
      roles: MANAGERS,
      params: tenantParams,
      body: z.object({
        period: z.enum(['daily', 'monthly']),
        hard_limit_usd: usd.nullable().optional(),
        soft_limit_usd: usd.nullable().optional(),
      }),
      handler: async ({ params, body, actor }) => {
        const hard = toMicros(body.hard_limit_usd);
        const soft = toMicros(body.soft_limit_usd);
        await setBudget(
          db,
          {
            tenantId: params.id,
            period: body.period,
            ...(hard !== undefined ? { hardLimitMicros: hard } : {}),
            ...(soft !== undefined ? { softLimitMicros: soft } : {}),
          },
          actor,
        );
        await publishBudgetChange(redis, params.id);
        return {
          period: body.period,
          hard_limit_usd: body.hard_limit_usd ?? null,
          soft_limit_usd: body.soft_limit_usd ?? null,
        };
      },
    },
    {
      method: 'PUT',
      url: '/tenants/:id/rate-limits',
      summary: 'Set tenant-wide or per-key requests and tokens per minute (null removes a limit)',
      roles: MANAGERS,
      params: tenantParams,
      body: z.object({
        key_prefix: z
          .string()
          .regex(/^[0-9A-Za-z]{8}$/)
          .optional(),
        rpm: z.number().int().positive().nullable().optional(),
        tpm: z.number().int().positive().nullable().optional(),
      }),
      handler: async ({ params, body, actor }) => {
        await setRateLimits(
          db,
          redis,
          { tenantId: params.id, ...(body.key_prefix ? { keyPrefix: body.key_prefix } : {}) },
          {
            ...(body.rpm !== undefined ? { rpm: body.rpm } : {}),
            ...(body.tpm !== undefined ? { tpm: body.tpm } : {}),
          },
          actor,
        );
        return { updated: true };
      },
    },
    {
      method: 'GET',
      url: '/models',
      summary: 'The model catalog with current prices',
      roles: ALL,
      handler: async () => ({
        data: deps.catalog
          .listModels()
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((m) => ({
            id: m.id,
            provider: m.provider,
            enabled: m.enabled,
            routable: m.routable,
            context_window: m.contextWindow,
            quality_tier: m.qualityTier,
            latency_tier: m.latencyTier,
            input_per_mtok_usd: microsToUsd(m.price?.inputPerMtokMicros ?? null),
            output_per_mtok_usd: microsToUsd(m.price?.outputPerMtokMicros ?? null),
          })),
      }),
    },
    {
      method: 'GET',
      url: '/routing-policies',
      summary: 'Virtual models and their fallback chains',
      roles: ALL,
      handler: async () => ({
        data: deps.catalog.listModels().length
          ? ['auto', 'gw/cheap-fast', 'gw/best-quality']
              .map((id) => deps.catalog.getPolicy(id))
              .filter((p) => p !== undefined)
              .map((p) => ({
                id: p.id,
                description: p.description,
                requirements: p.requirements,
                fallback_chain: p.fallbackChain,
                enabled: p.enabled,
              }))
          : [],
      }),
    },
    {
      method: 'GET',
      url: '/usage',
      summary: `Spend and volume over a time range (max ${MAX_RANGE_DAYS} days), grouped; CSV with Accept: text/csv`,
      roles: ALL,
      query: usageQuerySchema,
      handler: async ({ query, principal, reply, request }) => {
        // Tenant-scoped roles always see only their own tenant.
        const tenantId =
          principal.role === 'platform_admin' ? query.tenant_id : principal.tenantId!;
        if (
          principal.role !== 'platform_admin' &&
          query.tenant_id &&
          query.tenant_id !== principal.tenantId
        ) {
          throw new GatewayError(
            403,
            'permission',
            'tenant_forbidden',
            'You can only query your own tenant',
          );
        }
        const rows = await queryUsage(db, {
          from: new Date(query.from),
          to: new Date(query.to),
          groupBy: query.group_by,
          ...(tenantId ? { tenantId } : {}),
        });
        if ((request.headers.accept ?? '').includes('text/csv')) {
          return reply.type('text/csv; charset=utf-8').send(toCsv(rows, query.group_by));
        }
        return { data: rows };
      },
    },
  ];
}

/** Registers the routes behind admin authentication and role checks. */
export function registerAdminRoutes(
  scope: FastifyInstance,
  deps: AdminDeps,
  routes: AdminRoute[],
): void {
  scope.decorateRequest('admin', null);
  scope.addHook('onRequest', async (request) => {
    if (request.routeOptions.url === '/admin/v1/openapi.json') return;
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
    if (!token)
      throw new GatewayError(
        401,
        'authentication',
        'admin_auth_required',
        'Admin authentication is required',
      );
    if (token.startsWith('gw_live_')) {
      throw new GatewayError(
        403,
        'permission',
        'data_plane_key_not_allowed',
        'Gateway API keys cannot be used on admin routes',
      );
    }
    request.admin = await deps.authenticator.authenticate(token);
  });

  for (const route of routes) {
    scope.route({
      method: route.method,
      url: route.url,
      handler: async (request, reply) => {
        const principal = request.admin!;
        if (!route.roles.includes(principal.role)) {
          throw new GatewayError(
            403,
            'permission',
            'role_forbidden',
            `${principal.role} cannot ${route.method} ${route.url}`,
          );
        }
        const params = parse(route.params, request.params, 'params');
        if (
          params &&
          typeof params === 'object' &&
          'id' in params &&
          principal.role !== 'platform_admin' &&
          params.id !== principal.tenantId
        ) {
          throw new GatewayError(
            403,
            'permission',
            'tenant_forbidden',
            'You can only manage your own tenant',
          );
        }
        const actor: Actor = {
          type: 'admin',
          id: principal.subject,
          role: principal.role,
          route: `${route.method} ${route.url}`,
        };
        const result = await route.handler({
          params,
          body: parse(route.body, request.body, 'body'),
          query: parse(route.query, request.query, 'query'),
          principal,
          actor,
          reply,
          request,
        });
        if (reply.sent) return reply;
        return reply.code(route.status ?? 200).send(result);
      },
    });
  }
}

function parse(schema: z.ZodType | undefined, value: unknown, where: string): unknown {
  if (!schema) return value;
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.length ? i.path.join('.') : where}: ${i.message}`)
      .join('; ');
    throw new GatewayError(400, 'invalid_request', `invalid_${where}`, detail);
  }
  return result.data;
}
