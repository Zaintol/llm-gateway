import { eq } from 'drizzle-orm';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';
import { TtlCache } from '../auth/ttl-cache.js';
import { hashSecret, randomBase62, secretMatches } from '../auth/keys.js';
import type { Db } from '../db/client.js';
import { adminTokens, auditLog } from '../db/schema.js';
import { GatewayError } from '../errors.js';
import type { Actor, AdminRole } from '../tenancy/service.js';

export const ADMIN_ROLES = ['platform_admin', 'tenant_admin', 'finance_viewer'] as const;
const JWT_ISSUER = 'llm-gateway-dashboard';
const JWT_AUDIENCE = 'llm-gateway-admin';
const TOKEN_PATTERN = /^gw_admin_([0-9A-Za-z]{8})_([0-9A-Za-z]{43})$/;

/** An authenticated admin caller. Tenant-scoped roles carry their tenant; platform admins do not. */
export type AdminPrincipal = {
  subject: string;
  role: AdminRole;
  tenantId: string | null;
  via: 'jwt' | 'service_token';
};

const unauthorized = (code: string, message: string) =>
  new GatewayError(401, 'authentication', code, message);

/**
 * Mints a short-lived admin JWT. The dashboard calls this server-side after sign-in with the
 * shared ADMIN_JWT_SECRET; the token never needs to be stored.
 */
export async function mintAdminJwt(
  secret: string,
  claims: { subject: string; role: AdminRole; tenantId: string | null },
  ttlSeconds = 15 * 60,
): Promise<string> {
  return new SignJWT({ role: claims.role, tenant_id: claims.tenantId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.subject)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(new TextEncoder().encode(secret));
}

export class AdminAuthenticator {
  private readonly key: Uint8Array | undefined;
  private readonly cache = new TtlCache<{
    secretHash: string;
    principal: AdminPrincipal;
    revoked: boolean;
  }>(1000, 30_000);

  constructor(
    private readonly db: Db | undefined,
    jwtSecret: string | undefined,
  ) {
    this.key = jwtSecret ? new TextEncoder().encode(jwtSecret) : undefined;
  }

  async authenticate(token: string): Promise<AdminPrincipal> {
    const service = TOKEN_PATTERN.exec(token);
    if (service) return this.serviceToken(service[1]!, service[2]!);
    return this.jwt(token);
  }

  /** Drops a cached service token (after revocation). */
  invalidate(prefix: string): void {
    this.cache.delete(prefix);
  }

  private async jwt(token: string): Promise<AdminPrincipal> {
    if (!this.key)
      throw unauthorized('admin_auth_required', 'Admin JWT authentication is not configured');
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithms: ['HS256'],
        requiredClaims: ['exp', 'sub'],
      });
      const role = payload.role;
      if (typeof role !== 'string' || !(ADMIN_ROLES as readonly string[]).includes(role)) {
        throw unauthorized('invalid_admin_token', 'Admin token has no valid role');
      }
      const tenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id : null;
      if ((role === 'platform_admin') !== (tenantId === null)) {
        throw unauthorized('invalid_admin_token', 'Admin token scope does not match its role');
      }
      return { subject: payload.sub!, role: role as AdminRole, tenantId, via: 'jwt' };
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      if (err instanceof joseErrors.JWTExpired)
        throw unauthorized('admin_token_expired', 'Admin token has expired');
      throw unauthorized('invalid_admin_token', 'Invalid admin token');
    }
  }

  private async serviceToken(prefix: string, secret: string): Promise<AdminPrincipal> {
    let entry = this.cache.get(prefix);
    if (!entry && this.db) {
      const [row] = await this.db
        .select()
        .from(adminTokens)
        .where(eq(adminTokens.prefix, prefix))
        .limit(1);
      if (row) {
        entry = {
          secretHash: row.secretHash,
          revoked: row.revokedAt !== null,
          principal: {
            subject: `token:${row.name}`,
            role: row.role,
            tenantId: row.tenantId,
            via: 'service_token',
          },
        };
        this.cache.set(prefix, entry);
      }
    }
    if (!entry || !secretMatches(secret, entry.secretHash))
      throw unauthorized('invalid_admin_token', 'Invalid admin token');
    if (entry.revoked) throw unauthorized('admin_token_revoked', 'Admin token has been revoked');
    return entry.principal;
  }
}

/** Creates a service token; the full value is returned once and only its hash is stored. */
export async function createAdminToken(
  db: Db,
  input: { name: string; role: AdminRole; tenantId: string | null },
  actor: Actor,
): Promise<{ token: string; prefix: string }> {
  const prefix = randomBase62(8);
  const secret = randomBase62(43);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(adminTokens)
      .values({ ...input, prefix, secretHash: hashSecret(secret), createdBy: actor.id })
      .returning({ id: adminTokens.id });
    await tx.insert(auditLog).values({
      actorType: actor.type,
      actorId: actor.id,
      tenantId: input.tenantId,
      action: 'admin_token.create',
      targetType: 'admin_token',
      targetId: row!.id,
      metadata: { prefix, name: input.name, role: input.role },
    });
  });
  return { token: `gw_admin_${prefix}_${secret}`, prefix };
}
