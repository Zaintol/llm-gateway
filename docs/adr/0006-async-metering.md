# 6. Persist usage asynchronously through a queue, idempotently

- Status: accepted
- Date: 2026-10-14

## Context and problem statement

Every request that reaches a provider must produce a usage event with its cost, but writing to
Postgres on the request path adds latency and makes availability depend on the database. Events
must not be lost or double-counted when components retry.

## Considered options

- Synchronous insert in the request handler
- Fire-and-forget insert without retries
- Queue (BullMQ on Redis) with a separate worker, idempotent inserts, and a disk spill fallback

## Decision outcome

Chosen: **queue plus worker**. The gateway enqueues each event with `jobId = request_id`; a
separate `usage-worker` process inserts with `ON CONFLICT DO NOTHING` on `(request_id,
created_at)`, retrying five times with exponential backoff (about 2.5 minutes) before the job
stays in the failed set as a dead-letter queue. If Redis is unreachable, the event is appended to
an NDJSON spill file that is replayed on startup and every minute.

## Consequences

- Good: metering adds no database latency to requests and survives Postgres outages.
- Good: duplicates from redelivery or replay are harmless.
- Bad: usage rows appear seconds after the response, so budget reconciliation can briefly lag.
- Bad: one more process to run and monitor (dead-letter depth is logged).
