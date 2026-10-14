import { GatewayError } from '../errors.js';

export type DeadlineOptions = { defaultMs: number; maxMs: number };

/**
 * The request deadline from `x-gateway-timeout-ms`: default when absent, capped at the maximum.
 * The effective value is echoed in `x-gateway-deadline-ms`.
 */
export function effectiveDeadlineMs(
  header: string | string[] | undefined,
  options: DeadlineOptions,
): number {
  if (header === undefined) return options.defaultMs;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !/^\d+$/.test(value.trim()) || Number(value) <= 0) {
    throw new GatewayError(
      400,
      'invalid_request',
      'invalid_timeout',
      'x-gateway-timeout-ms must be a positive integer number of milliseconds',
    );
  }
  return Math.min(Number(value), options.maxMs);
}
