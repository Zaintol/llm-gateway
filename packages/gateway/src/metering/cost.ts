import type { ModelPrice } from '../catalog/catalog.js';
import type { ProviderUsage } from '../providers/types.js';

/** n / d rounded to the nearest integer, ties to even (banker's rounding). Requires n >= 0, d > 0. */
export function divRoundHalfEven(n: bigint, d: bigint): bigint {
  const quotient = n / d;
  const twiceRemainder = (n % d) * 2n;
  if (twiceRemainder > d) return quotient + 1n;
  if (twiceRemainder < d) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/**
 * Request cost in integer micro-USD. Prices are micro-USD per million tokens, so the sum is
 * exact until the single division at the end. `inputTokens` includes cached tokens (OpenAI
 * semantics); cached tokens are billed at the cached price, or the input price when none is set.
 */
export function computeCostMicros(usage: ProviderUsage, price: ModelPrice): bigint {
  const cached = BigInt(Math.min(usage.cachedInputTokens, usage.inputTokens));
  const uncached = BigInt(usage.inputTokens) - cached;
  const cachedPrice = price.cachedInputPerMtokMicros ?? price.inputPerMtokMicros;
  const numerator =
    uncached * price.inputPerMtokMicros +
    cached * cachedPrice +
    BigInt(usage.outputTokens) * price.outputPerMtokMicros;
  return divRoundHalfEven(numerator, 1_000_000n);
}
