import { SignJWT } from 'jose';
import type { Principal } from './auth';
import { config } from './config';

/**
 * Calls the gateway admin API as the signed-in person. A fresh 15-minute admin JWT is minted per
 * request with the shared secret; the claims contract mirrors the gateway's admin/auth.ts
 * (issuer, audience, role, tenant_id).
 */
async function adminToken(principal: Principal): Promise<string> {
  return new SignJWT({ role: principal.role, tenant_id: principal.tenantId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(principal.email)
    .setIssuer('llm-gateway-dashboard')
    .setAudience('llm-gateway-admin')
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(config.adminJwtSecret()));
}

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function adminGet<T>(principal: Principal, path: string): Promise<T> {
  const res = await fetch(`${config.gatewayUrl()}/admin/v1${path}`, {
    headers: { authorization: `Bearer ${await adminToken(principal)}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    let message = `Admin API returned ${res.status}`;
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // keep the generic message
    }
    throw new AdminApiError(res.status, message);
  }
  return (await res.json()) as T;
}
