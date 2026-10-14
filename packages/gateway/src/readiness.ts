import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

export type DependencyCheck = () => Promise<void>;

export type ReadinessReport = {
  ready: boolean;
  checks: Record<string, 'ok' | 'error'>;
};

function withTimeout(check: DependencyCheck, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    check().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export async function checkReadiness(
  checks: Record<string, DependencyCheck>,
  timeoutMs: number,
): Promise<ReadinessReport> {
  const names = Object.keys(checks);
  const results = await Promise.allSettled(
    names.map((name) => withTimeout(checks[name]!, timeoutMs)),
  );
  const report: ReadinessReport = { ready: true, checks: {} };
  results.forEach((result, i) => {
    const ok = result.status === 'fulfilled';
    report.checks[names[i]!] = ok ? 'ok' : 'error';
    if (!ok) report.ready = false;
  });
  return report;
}

export const postgresCheck =
  (pool: Pool): DependencyCheck =>
  async () => {
    await pool.query('select 1');
  };

export const redisCheck =
  (redis: Redis): DependencyCheck =>
  async () => {
    await redis.ping();
  };
