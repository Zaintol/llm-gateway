import type { FastifyInstance } from 'fastify';
import { GatewayError } from '../errors.js';
import type { AuthContext, Authenticator } from './authenticator.js';
import type { FailureLimiter } from './failure-limiter.js';
import { inSpan } from '../observability/tracing.js';
import { looksLikeDataPlaneKey } from './keys.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export type DataPlaneAuth = { authenticator: Authenticator; failureLimiter: FailureLimiter };

/** Requires a valid gateway key on every route registered in `scope`. */
export function requireApiKey(
  scope: FastifyInstance,
  { authenticator, failureLimiter }: DataPlaneAuth,
) {
  scope.decorateRequest('auth', null);
  scope.addHook('onRequest', async (request) => {
    if (await failureLimiter.isBlocked(request.ip)) {
      throw new GatewayError(
        429,
        'rate_limited',
        'too_many_auth_failures',
        'Too many failed authentication attempts. Try again later',
        { 'retry-after': '60' },
      );
    }
    try {
      request.auth = await inSpan('auth', {}, () =>
        authenticator.authenticate(request.headers.authorization),
      );
      request.telemetry?.span?.setAttributes({
        'tenant.id': request.auth.tenantId,
        'key.prefix': request.auth.keyPrefix,
      });
    } catch (err) {
      if (err instanceof GatewayError && err.type === 'authentication') {
        await failureLimiter.recordFailure(request.ip);
      }
      throw err;
    }
    request.log = request.log.child({
      tenantId: request.auth.tenantId,
      keyPrefix: request.auth.keyPrefix,
    });
  });
}

/**
 * Guards the admin plane. Data-plane keys are always refused; admin credentials arrive in GW-9.1,
 * until then every admin request is rejected.
 */
export function guardAdminPlane(scope: FastifyInstance) {
  scope.addHook('onRequest', async (request) => {
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
    if (token && looksLikeDataPlaneKey(token)) {
      throw new GatewayError(
        403,
        'permission',
        'data_plane_key_not_allowed',
        'Gateway API keys cannot be used on admin routes',
      );
    }
    throw new GatewayError(
      401,
      'authentication',
      'admin_auth_required',
      'Admin authentication is required',
    );
  });
}
