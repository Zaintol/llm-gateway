/**
 * Canonical upstream failure kinds.
 * - retryable: the same provider may succeed if retried (after backoff).
 * - fallbackEligible: another provider may serve the request instead.
 */
export type ProviderErrorKind =
  'rate_limited' | 'provider_error' | 'provider_timeout' | 'provider_auth' | 'invalid_request';

const policy: Record<ProviderErrorKind, { retryable: boolean; fallbackEligible: boolean }> = {
  rate_limited: { retryable: true, fallbackEligible: true },
  provider_error: { retryable: true, fallbackEligible: true },
  provider_timeout: { retryable: true, fallbackEligible: true },
  // Bad credentials will not fix themselves, but another provider may still serve the request.
  provider_auth: { retryable: false, fallbackEligible: true },
  // The request itself is wrong: every provider would reject it.
  invalid_request: { retryable: false, fallbackEligible: false },
};

export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly fallbackEligible: boolean;

  constructor(
    readonly kind: ProviderErrorKind,
    readonly provider: string,
    message: string,
    readonly upstreamStatus?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
    ({ retryable: this.retryable, fallbackEligible: this.fallbackEligible } = policy[kind]);
  }
}

/** Shared HTTP status mapping for OpenAI-style APIs. */
export function errorKindForStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'provider_auth';
  if (status === 408) return 'provider_timeout';
  if (status >= 500) return 'provider_error';
  if (status >= 400) return 'invalid_request';
  return 'provider_error';
}
