import type { Redis } from 'ioredis';

/**
 * Cross-instance cache invalidation for admin changes, so an update applies to the next request
 * on every gateway instance instead of after a cache TTL.
 */
export const CHANNELS = {
  budgets: 'gw:budgets:invalidate',
  credentials: 'gw:credentials:invalidate',
} as const;

export type InvalidationHandlers = {
  budgets?: (tenantId: string) => void;
  /** Payload is `<tenantId>:<provider>`, or `*` for platform-wide credentials. */
  credentials?: (scope: string) => void;
};

export async function subscribeToInvalidations(
  subscriber: Redis,
  handlers: InvalidationHandlers,
): Promise<void> {
  subscriber.on('message', (channel: string, message: string) => {
    if (channel === CHANNELS.budgets) handlers.budgets?.(message);
    if (channel === CHANNELS.credentials) handlers.credentials?.(message);
  });
  await subscriber.subscribe(CHANNELS.budgets, CHANNELS.credentials);
}

export const publishBudgetChange = (redis: Redis, tenantId: string) =>
  redis.publish(CHANNELS.budgets, tenantId);
export const publishCredentialChange = (redis: Redis, tenantId: string | null, provider: string) =>
  redis.publish(CHANNELS.credentials, tenantId === null ? '*' : `${tenantId}:${provider}`);
