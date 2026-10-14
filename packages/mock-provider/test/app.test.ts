import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('mock provider', () => {
  it('reports healthy', async () => {
    const app = buildApp({ logLevel: 'silent' });
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
