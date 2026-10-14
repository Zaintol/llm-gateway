import { Agent, fetch as undiciFetch } from 'undici';

/**
 * fetch for provider calls: a shared keep-alive connection pool with a connect timeout, so an
 * unreachable host fails in seconds instead of eating the whole request deadline.
 */
export function providerFetch(options: { connectTimeoutMs: number }): typeof fetch {
  const dispatcher = new Agent({
    connect: { timeout: options.connectTimeoutMs },
    keepAliveTimeout: 30_000,
  });
  return ((input: string | URL, init?: RequestInit) =>
    undiciFetch(input, { ...(init as object), dispatcher })) as unknown as typeof fetch;
}
