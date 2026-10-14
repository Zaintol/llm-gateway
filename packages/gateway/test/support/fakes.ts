import type { ChatCompletionRequest } from '@gw/schema';
import type { CredentialSource } from '../../src/chat/route.js';
import type { ResolvedCredential } from '../../src/credentials/service.js';
import type { ProviderAdapter, ProviderCall, ProviderResult } from '../../src/providers/types.js';
import { Authenticator, type AuthenticatorOptions } from '../../src/auth/authenticator.js';
import type { FailureLimiter } from '../../src/auth/failure-limiter.js';
import type { KeyRecord, KeyStore } from '../../src/auth/key-store.js';
import { generateApiKey } from '../../src/auth/keys.js';
import type { DataPlaneAuth } from '../../src/auth/plugin.js';

export class InMemoryKeyStore implements KeyStore {
  readonly records = new Map<string, KeyRecord>();
  lookups = 0;
  touches: string[] = [];

  async findByPrefix(prefix: string): Promise<KeyRecord | null> {
    this.lookups++;
    return this.records.get(prefix) ?? null;
  }

  async touchLastUsed(keyId: string): Promise<void> {
    this.touches.push(keyId);
  }

  /** Adds a key and returns the full key string a client would send. */
  add(overrides: Partial<KeyRecord> = {}): { key: string; record: KeyRecord } {
    const generated = generateApiKey();
    const record: KeyRecord = {
      keyId: `key_${generated.prefix}`,
      tenantId: 'tenant_1',
      prefix: generated.prefix,
      secretHash: generated.secretHash,
      expiresAt: null,
      revokedAt: null,
      tenantStatus: 'active',
      tenantSettings: {},
      ...overrides,
    };
    this.records.set(record.prefix, record);
    return { key: generated.key, record };
  }
}

export class InMemoryFailureLimiter implements FailureLimiter {
  readonly failures = new Map<string, number>();
  constructor(private readonly limit = 20) {}

  async isBlocked(ip: string): Promise<boolean> {
    return (this.failures.get(ip) ?? 0) >= this.limit;
  }

  async recordFailure(ip: string): Promise<void> {
    this.failures.set(ip, (this.failures.get(ip) ?? 0) + 1);
  }
}

export function fakeAuth(options: AuthenticatorOptions = {}) {
  const store = new InMemoryKeyStore();
  const failureLimiter = new InMemoryFailureLimiter();
  const auth: DataPlaneAuth = { authenticator: new Authenticator(store, options), failureLimiter };
  return { store, failureLimiter, auth };
}

export class StaticCredentials implements CredentialSource {
  constructor(private readonly byProvider: Record<string, ResolvedCredential> = {}) {}
  async resolve(_tenantId: string, provider: string) {
    return this.byProvider[provider] ?? null;
  }
}

/** Adapter double that records calls and returns a canned result or throws. */
export class FakeAdapter implements ProviderAdapter {
  calls: Array<{ request: ChatCompletionRequest; call: ProviderCall }> = [];
  constructor(
    readonly provider: string,
    private readonly behaviour: (
      request: ChatCompletionRequest,
    ) => ProviderResult | Promise<ProviderResult>,
    readonly requiresCredential = false,
  ) {}
  async complete(request: ChatCompletionRequest, call: ProviderCall) {
    this.calls.push({ request, call });
    return this.behaviour(request);
  }
}

export function cannedResult(model: string, content = 'hello'): ProviderResult {
  return {
    response: {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    },
    usage: { inputTokens: 3, outputTokens: 1, cachedInputTokens: 0, source: 'provider' },
  };
}
