import { Redis } from 'ioredis';

export function createRedis(url: string): Redis {
  return new Redis(url, {
    // Fail fast instead of queueing commands while disconnected, so readiness and
    // (later) budget checks report an outage rather than hanging.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    lazyConnect: true,
  });
}

/**
 * Connection for pub/sub. Unlike the command connection it queues while disconnected, so the
 * subscription is established as soon as Redis is reachable and restored after reconnects.
 */
export function createSubscriber(url: string): Redis {
  return new Redis(url, { lazyConnect: true });
}
