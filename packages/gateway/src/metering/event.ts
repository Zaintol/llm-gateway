import { z } from 'zod';
import { priceAt } from '../catalog/catalog.js';
import type { AttemptRecord } from '../execution/engine.js';
import type { ProviderUsage } from '../providers/types.js';
import type { Candidate } from '../routing/planner.js';
import type { NewUsageEvent } from '../db/usage-events.js';
import { computeCostMicros } from './cost.js';

export type UsageStatus = 'success' | 'error' | 'partial' | 'client_cancelled';

/**
 * A usage event as queued: JSON-safe (cost as a decimal string). Never carries prompt or
 * completion text, only counts and identifiers.
 */
export const usageEventSchema = z.object({
  requestId: z.string().min(1),
  tenantId: z.uuid(),
  apiKeyId: z.uuid(),
  requestedModel: z.string(),
  modelId: z.string().min(1),
  provider: z.string().min(1),
  priceId: z.uuid().nullable(),
  credentialScope: z.enum(['tenant', 'platform']).nullable(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  costMicros: z.string().regex(/^\d+$/),
  usageSource: z.enum(['provider', 'estimated', 'none']),
  status: z.enum(['success', 'error', 'partial', 'client_cancelled']),
  attempts: z.number().int().min(0),
  fallbackUsed: z.boolean(),
  latencyMs: z.number().int().min(0),
  ttftMs: z.number().int().min(0).nullable(),
  routeReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export type UsageEvent = z.infer<typeof usageEventSchema>;

export function toUsageEventRow(event: UsageEvent): NewUsageEvent {
  return { ...event, costMicros: BigInt(event.costMicros), createdAt: new Date(event.createdAt) };
}

export type UsageEventInput = {
  requestId: string;
  tenantId: string;
  apiKeyId: string;
  requestedModel: string;
  status: UsageStatus;
  /** Candidate that served the request, or the last one attempted. */
  model: Candidate;
  /** First candidate in the plan; serving any other means fallback was used. */
  firstCandidateId: string;
  attempts: AttemptRecord[];
  /** Billed usage; absent when nothing was billed (all attempts failed). */
  usage: ProviderUsage | undefined;
  startedAt: Date;
  finishedAt: Date;
  ttftMs: number | null;
  routeReason: string | null;
};

/** Prices the request at the price row in effect when it started. */
export function buildUsageEvent(input: UsageEventInput): UsageEvent {
  const price = input.model.model ? priceAt(input.model.model, input.startedAt) : null;
  const cost = input.usage && price ? computeCostMicros(input.usage, price) : 0n;
  return {
    requestId: input.requestId,
    tenantId: input.tenantId,
    apiKeyId: input.apiKeyId,
    requestedModel: input.requestedModel,
    modelId: input.model.id,
    provider: input.model.provider,
    priceId: price?.id ?? null,
    credentialScope: input.model.credential?.scope ?? null,
    inputTokens: input.usage?.inputTokens ?? 0,
    outputTokens: input.usage?.outputTokens ?? 0,
    cachedInputTokens: input.usage?.cachedInputTokens ?? 0,
    costMicros: cost.toString(),
    usageSource: input.usage?.source ?? 'none',
    status: input.status,
    attempts: input.attempts.length,
    fallbackUsed: input.model.id !== input.firstCandidateId,
    latencyMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
    ttftMs: input.ttftMs,
    routeReason: input.routeReason?.slice(0, 500) ?? null,
    createdAt: input.startedAt.toISOString(),
  };
}
