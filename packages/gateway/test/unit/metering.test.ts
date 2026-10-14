import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { priceAt, type ModelPrice } from '../../src/catalog/catalog.js';
import { computeCostMicros, divRoundHalfEven } from '../../src/metering/cost.js';
import {
  buildUsageEvent,
  usageEventSchema,
  type UsageEventInput,
} from '../../src/metering/event.js';
import { QueueUsageRecorder } from '../../src/metering/recorder.js';
import { SpillFile } from '../../src/metering/spill.js';
import { catalogModel } from '../support/fakes.js';

const price = (overrides: Partial<ModelPrice> = {}): ModelPrice => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveTo: null,
  inputPerMtokMicros: 150_000n, // 0.15 USD / Mtok
  outputPerMtokMicros: 600_000n, // 0.60 USD / Mtok
  cachedInputPerMtokMicros: 75_000n,
  ...overrides,
});

describe('cost calculation (GW-7.1)', () => {
  it('prices 1000 input and 500 output tokens exactly in micro-USD', () => {
    // 1000 * 0.15/1e6 + 500 * 0.60/1e6 USD = 0.00045 USD = 450 micro-USD
    expect(
      computeCostMicros(
        { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0, source: 'provider' },
        price(),
      ),
    ).toBe(450n);
  });

  it('bills cached input at the cached price, or at the input price when none is set', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 400_000,
      source: 'provider' as const,
    };
    // 600k uncached * 0.15 + 400k cached * 0.075 = 0.09 + 0.03 USD
    expect(computeCostMicros(usage, price())).toBe(120_000n);
    expect(computeCostMicros(usage, price({ cachedInputPerMtokMicros: null }))).toBe(150_000n);
  });

  it('rounds half to even only at the final step', () => {
    expect([5n, 15n, 25n, 35n, 26n, 24n].map((n) => divRoundHalfEven(n, 10n))).toEqual([
      0n,
      2n,
      2n,
      4n,
      3n,
      2n,
    ]);
    // 3 output tokens at 0.5 micro each = 1.5 micro -> 2 (not 3 x round(0.5) = 0)
    expect(
      computeCostMicros(
        { inputTokens: 0, outputTokens: 3, cachedInputTokens: 0, source: 'provider' },
        price({ outputPerMtokMicros: 500_000n }),
      ),
    ).toBe(2n);
  });
});

describe('price lookup', () => {
  it('uses the price in effect when the request started, even across a price change', () => {
    const change = new Date('2026-06-01T00:00:00Z');
    const old = price({ id: 'old', effectiveTo: change });
    const next = price({ id: 'new', effectiveFrom: change, outputPerMtokMicros: 900_000n });
    expect(priceAt({ prices: [old, next] }, new Date(change.getTime() - 1000))?.id).toBe('old');
    expect(priceAt({ prices: [old, next] }, change)?.id).toBe('new');
    expect(priceAt({ prices: [old, next] }, new Date('2025-01-01T00:00:00Z'))).toBeNull();
  });
});

describe('buildUsageEvent', () => {
  const change = new Date('2026-06-01T00:00:00Z');
  const model = catalogModel({
    id: 'openai/gpt',
    provider: 'openai',
    prices: [
      price({ id: '00000000-0000-4000-8000-00000000000a', effectiveTo: change }),
      price({
        id: '00000000-0000-4000-8000-00000000000b',
        effectiveFrom: change,
        outputPerMtokMicros: 1_200_000n,
      }),
    ],
  });
  const input = (overrides: Partial<UsageEventInput> = {}): UsageEventInput => ({
    requestId: 'req_1',
    tenantId: '00000000-0000-4000-8000-000000000001',
    apiKeyId: '00000000-0000-4000-8000-000000000002',
    requestedModel: 'auto',
    status: 'success',
    model: {
      id: model.id,
      provider: 'openai',
      upstreamModel: 'gpt',
      adapter: {} as never,
      model,
      credential: { secret: 's', baseUrl: null, scope: 'platform' },
    },
    firstCandidateId: 'openai/gpt',
    attempts: [
      { model: 'openai/gpt', provider: 'openai', attempt: 1, outcome: 'success', durationMs: 5 },
    ],
    usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0, source: 'provider' },
    startedAt: new Date(change.getTime() - 1000),
    finishedAt: new Date(change.getTime() + 500),
    ttftMs: null,
    routeReason: 'policy:auto',
    ...overrides,
  });

  it('costs a request by the price row in effect at its start, not its end', () => {
    const event = buildUsageEvent(input());
    expect(event).toMatchObject({
      priceId: '00000000-0000-4000-8000-00000000000a',
      costMicros: '450',
      usageSource: 'provider',
      credentialScope: 'platform',
      latencyMs: 1500,
      createdAt: '2026-05-31T23:59:59.000Z',
    });
    expect(usageEventSchema.safeParse(event).success).toBe(true);
  });

  it('records no cost when no attempt got a billable response', () => {
    const event = buildUsageEvent(input({ status: 'error', usage: undefined }));
    expect(event).toMatchObject({
      status: 'error',
      costMicros: '0',
      usageSource: 'none',
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('flags fallback when the serving model was not the first candidate', () => {
    expect(buildUsageEvent(input({ firstCandidateId: 'anthropic/claude' })).fallbackUsed).toBe(
      true,
    );
    expect(buildUsageEvent(input()).fallbackUsed).toBe(false);
  });

  it('carries counts and identifiers only', () => {
    expect(Object.keys(buildUsageEvent(input())).sort()).toEqual(
      Object.keys(usageEventSchema.shape).sort(),
    );
  });
});

describe('QueueUsageRecorder', () => {
  const event = buildUsageEvent({
    requestId: 'req_spill',
    tenantId: '00000000-0000-4000-8000-000000000001',
    apiKeyId: '00000000-0000-4000-8000-000000000002',
    requestedModel: 'mock/fast',
    status: 'success',
    model: {
      id: 'mock/fast',
      provider: 'mock',
      upstreamModel: 'fast',
      adapter: {} as never,
      model: catalogModel(),
      credential: null,
    },
    firstCandidateId: 'mock/fast',
    attempts: [],
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, source: 'provider' },
    startedAt: new Date('2026-03-01T00:00:00Z'),
    finishedAt: new Date('2026-03-01T00:00:01Z'),
    ttftMs: null,
    routeReason: null,
  });
  const silent = { warn: () => {}, error: () => {} };
  const spillFile = () =>
    new SpillFile(path.join(mkdtempSync(path.join(tmpdir(), 'spill-')), 'usage.ndjson'));

  it('spills to disk when the queue rejects, and replays later', async () => {
    const spill = spillFile();
    const down = new QueueUsageRecorder(
      { add: async () => Promise.reject(new Error('ECONNREFUSED')) },
      spill,
      silent,
    );
    down.record(event);
    await down.flush();
    expect(
      readFileSync(spill.file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).requestId),
    ).toEqual(['req_spill']);

    const queued: unknown[] = [];
    const up = new QueueUsageRecorder(
      { add: async (_name, data) => void queued.push(data) as never },
      spill,
      silent,
    );
    expect(await up.replaySpill()).toBe(1);
    expect(queued).toEqual([event]);
    expect(await spill.size()).toBe(0);
  });

  it('spills when the queue hangs longer than the enqueue timeout', async () => {
    const spill = spillFile();
    const hanging = new QueueUsageRecorder({ add: () => new Promise(() => {}) }, spill, silent, 50);
    hanging.record(event);
    await hanging.flush();
    expect(await spill.size()).toBeGreaterThan(0);
  });

  it('keeps events whose replay fails in the spill file', async () => {
    const spill = spillFile();
    await spill.append(event);
    await spill.append({ ...event, requestId: 'req_spill_2' });
    const flaky = new QueueUsageRecorder(
      { add: async () => Promise.reject(new Error('still down')) },
      spill,
      silent,
    );
    expect(await flaky.replaySpill()).toBe(0);
    expect(readFileSync(spill.file, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
