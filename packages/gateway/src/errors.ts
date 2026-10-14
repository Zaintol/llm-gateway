/**
 * Canonical error taxonomy. Every non-2xx response carries one of these types in the OpenAI
 * error envelope, so clients and dashboards can group failures without parsing messages.
 */
export type ErrorType =
  | 'invalid_request'
  | 'authentication'
  | 'permission'
  | 'not_found'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'provider_error'
  | 'provider_timeout'
  | 'no_eligible_model'
  | 'internal';

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly type: ErrorType,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
