import { ProviderError, errorKindForStatus } from './errors.js';
import type { ProviderCall } from './types.js';

/** Base URL from the credential row, else the adapter default; trailing slashes removed. */
export function resolveBaseUrl(
  provider: string,
  call: ProviderCall,
  defaultBaseUrl?: string,
): string {
  const baseUrl = (call.credential?.baseUrl ?? defaultBaseUrl)?.replace(/\/+$/, '');
  if (!baseUrl) {
    throw new ProviderError('provider_error', provider, `No base URL configured for ${provider}`);
  }
  return baseUrl;
}

const timedOut = (provider: string) =>
  new ProviderError('provider_timeout', provider, `${provider} did not respond in time`);

/** Maps a non-2xx response; OpenAI and Anthropic both put the reason in `error.message`. */
export async function errorFromResponse(provider: string, res: Response): Promise<ProviderError> {
  let message = `${provider} returned HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') message = body.error.message;
  } catch {
    // Non-JSON error body: keep the generic message.
  }
  const retryAfter = Number(res.headers.get('retry-after'));
  return new ProviderError(
    errorKindForStatus(res.status),
    provider,
    message,
    res.status,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  );
}

/**
 * POSTs JSON to a provider and returns the parsed body. Every failure (network, timeout, HTTP
 * status, unparsable body) surfaces as a ProviderError.
 */
export async function postJson(options: {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  fetch: typeof fetch;
}): Promise<unknown> {
  const { provider, signal } = options;
  let res: Response;
  try {
    res = await options.fetch(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(options.body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw timedOut(provider);
    throw new ProviderError(
      'provider_error',
      provider,
      `Could not reach ${provider}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw await errorFromResponse(provider, res);
  try {
    return await res.json();
  } catch {
    if (signal.aborted) throw timedOut(provider);
    throw new ProviderError('provider_error', provider, 'Provider returned invalid JSON');
  }
}
