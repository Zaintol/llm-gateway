import { describe, expect, it } from 'vitest';
import { providerFetch } from '../../src/providers/fetch.js';

describe('providerFetch', () => {
  it('fails fast when a host cannot be connected to', async () => {
    const fetchUpstream = providerFetch({ connectTimeoutMs: 200 });
    const started = Date.now();
    // 10.255.255.1 is non-routable: the TCP handshake never completes (or fails immediately).
    await expect(fetchUpstream('http://10.255.255.1:81/v1/chat/completions')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
