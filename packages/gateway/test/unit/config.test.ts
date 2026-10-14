import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

const valid = {
  DATABASE_URL: 'postgres://gw:gw@localhost:5432/gw',
  REDIS_URL: 'redis://localhost:6379',
  GATEWAY_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('loadConfig', () => {
  it('applies defaults when only required variables are set', () => {
    expect(loadConfig(valid)).toMatchObject({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 3000,
      LOG_LEVEL: 'info',
      READINESS_TIMEOUT_MS: 1000,
    });
  });

  it('reports every missing required variable at once', () => {
    let error: unknown;
    try {
      loadConfig({});
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual([
      'DATABASE_URL is required',
      'REDIS_URL is required',
      'GATEWAY_MASTER_KEY is required',
    ]);
  });

  it.each([
    ['wrong length', Buffer.alloc(16).toString('base64')],
    ['not base64', 'not-a-key!'],
  ])('rejects a master key with the %s', (_case, key) => {
    expect(() => loadConfig({ ...valid, GATEWAY_MASTER_KEY: key })).toThrow(
      /GATEWAY_MASTER_KEY: must be 32 bytes/,
    );
  });

  it('parses previous master keys kept for rotation', () => {
    const old = Buffer.alloc(32, 1).toString('base64');
    const config = loadConfig({
      ...valid,
      GATEWAY_MASTER_KEY_VERSION: '2',
      GATEWAY_PREVIOUS_MASTER_KEYS: `1:${old}`,
    });
    expect(config.GATEWAY_PREVIOUS_MASTER_KEYS).toEqual(new Map([[1, old]]));
  });

  it('rejects malformed values with the variable name', () => {
    expect(() => loadConfig({ ...valid, PORT: 'eighty', REDIS_URL: 'http://x' })).toThrow(
      /PORT: .*\n.*REDIS_URL: /,
    );
  });
});

describe('gateway process', () => {
  it('exits non-zero and names every missing variable', () => {
    const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const result = spawnSync(
      process.execPath,
      ['--conditions=@gw/source', '--import', 'tsx', 'src/server.ts'],
      { cwd: pkgRoot, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 20_000 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL is required');
    expect(result.stderr).toContain('REDIS_URL is required');
    expect(result.stderr).toContain('GATEWAY_MASTER_KEY is required');
  });

  it('exits non-zero before listening when the master key has the wrong length', () => {
    const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const result = spawnSync(
      process.execPath,
      ['--conditions=@gw/source', '--import', 'tsx', 'src/server.ts'],
      {
        cwd: pkgRoot,
        env: { PATH: process.env.PATH, ...valid, GATEWAY_MASTER_KEY: 'c2hvcnQ=' },
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GATEWAY_MASTER_KEY: must be 32 bytes');
    expect(result.stdout).not.toContain('Server listening');
  });
});
