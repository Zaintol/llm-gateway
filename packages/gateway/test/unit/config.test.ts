import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

const valid = {
  DATABASE_URL: 'postgres://gw:gw@localhost:5432/gw',
  REDIS_URL: 'redis://localhost:6379',
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
    ]);
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
  });
});
