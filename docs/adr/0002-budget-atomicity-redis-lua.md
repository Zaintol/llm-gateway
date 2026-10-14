# 2. Enforce hard budgets with reserve-and-settle Lua scripts in Redis

- Status: accepted
- Date: 2026-10-14

## Context and problem statement

A hard budget must hold under concurrency: 50 simultaneous requests against a tenant with $0.05
left must not all be admitted. The true cost of a request is only known after the provider
answers, but the admission decision has to be made before the call. Postgres is the system of
record for spend, but a row lock per request on the hot path would serialise each tenant.

## Considered options

- Check settled spend in Postgres, then call (racy: everything in flight is invisible)
- `SELECT … FOR UPDATE` on a per-tenant budget row (correct, but serialises the tenant)
- Reserve the worst-case cost atomically in Redis, settle to the actual cost afterwards

## Decision outcome

Chosen: **reserve and settle in Redis with Lua**. Before any provider call, one Lua script checks
every hard-limited period counter (UTC day and month) and increments all of them by the request's
worst-case cost only if all stay within their limits. After the call a second script applies
`actual − reserved`. Falling back to a pricier model reserves the difference first. Each
reservation is a lease; a sweeper refunds leases orphaned by crashed instances, and a
reconciliation job rebuilds counters from `usage_events` (keeping open reservations).

## Consequences

- Good: overshoot is bounded by one reservation, not by concurrency (50 concurrent $0.05 requests
  against $1.00 admit exactly 20; see `budgets.test.ts`).
- Good: one Redis round trip per request; no database lock on the hot path.
- Bad: worst-case reservation rejects some requests near the limit that would have fitted.
- Bad: Redis becomes part of correctness; when it is down, tenants with a hard limit fail closed
  (503 `budget_unavailable`).
- Bad: reconciliation can briefly undercount costs still in the metering queue.
