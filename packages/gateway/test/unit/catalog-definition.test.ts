import { describe, expect, it } from 'vitest';
import {
  CatalogDefinitionError,
  loadCatalogFile,
  parseCatalog,
  usdToMicros,
} from '../../src/catalog/definition.js';

const model = (id: string, extra = '') => `
  - id: ${id}
    upstream_model: x
    context_window: 1000
    max_output_tokens: 100
    capabilities: { tools: true }
    quality_tier: 1
    latency_tier: fast
${extra}`;
const price = `    price: { input_per_mtok_usd: 0.15, output_per_mtok_usd: 0.6, source_url: https://example.com, effective_from: 2026-01-01 }`;

function problems(source: string): string[] {
  try {
    parseCatalog(source);
  } catch (err) {
    if (err instanceof CatalogDefinitionError) return err.problems;
    throw err;
  }
  return [];
}

describe('catalog definition', () => {
  it('parses the repository catalog', () => {
    const catalog = loadCatalogFile();
    expect(catalog.models.length).toBeGreaterThan(5);
    expect(catalog.routingPolicies.map((p) => p.id)).toContain('auto');
  });

  it('names a model that has no price', () => {
    expect(problems(`models:${model('openai/a', price)}${model('openai/no-price')}`)).toEqual([
      'model "openai/no-price" has no price',
    ]);
  });

  it('rejects duplicate ids and chains that reference unknown models', () => {
    const source = `models:${model('openai/a', price)}${model('openai/a', price)}
routing_policies:
  - { id: auto, description: d, fallback_chain: [openai/a, openai/missing] }`;
    expect(problems(source)).toEqual([
      'model "openai/a" is defined more than once',
      'routing policy "auto" references unknown model "openai/missing"',
    ]);
  });

  it('requires provider/model ids', () => {
    expect(problems(`models:${model('no-slash', price)}`)[0]).toMatch(
      /must look like <provider>\/<model>/,
    );
  });

  it('converts USD per million tokens to exact micro-USD', () => {
    expect(usdToMicros(0.15)).toBe(150_000n);
    expect(usdToMicros(0.075)).toBe(75_000n);
    expect(usdToMicros(15)).toBe(15_000_000n);
    expect(() => usdToMicros(0.0000001)).toThrow(/precision/);
  });
});
