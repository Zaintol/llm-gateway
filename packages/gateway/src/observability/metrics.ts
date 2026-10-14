import { Counter, Registry, collectDefaultMetrics } from 'prom-client';

/** Process-wide Prometheus registry, served at GET /metrics. RED metrics arrive with GW-8.2. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'gateway_process_' });

export const rateLimitDegraded = new Counter({
  name: 'gateway_ratelimit_degraded_total',
  help: 'Requests admitted without rate limiting because Redis was unavailable',
  registers: [registry],
});
