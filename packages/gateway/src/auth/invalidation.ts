import type { Redis } from 'ioredis';
import type { Authenticator } from './authenticator.js';

/** Pub/sub channel carrying key prefixes whose cached auth entries must be dropped. */
export const AUTH_INVALIDATION_CHANNEL = 'gw:auth:invalidate';

export async function publishKeyInvalidation(redis: Redis, prefix: string): Promise<void> {
  await redis.publish(AUTH_INVALIDATION_CHANNEL, prefix);
}

/** `subscriber` must be a dedicated connection: a subscribed Redis client cannot run commands. */
export async function subscribeToKeyInvalidations(
  subscriber: Redis,
  authenticator: Authenticator,
): Promise<void> {
  subscriber.on('message', (channel: string, prefix: string) => {
    if (channel === AUTH_INVALIDATION_CHANNEL) authenticator.invalidate(prefix);
  });
  await subscriber.subscribe(AUTH_INVALIDATION_CHANNEL);
}
