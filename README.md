# LLM gateway

One OpenAI-compatible API across OpenAI, Anthropic, Gemini and local models, with fallback,
retries, per-tenant budgets, cost-aware routing and a usage dashboard. See [PLAN.md](PLAN.md) for
the product brief, architecture and backlog.

**Status:** Phase 0 (foundations) complete — monorepo, CI, local stack, core schema. No LLM traffic
is proxied yet; that starts in Phase 1.

## Quick start

Requires Docker, Node 22+ and pnpm 10 (`corepack enable`).

```bash
cp .env.example .env
docker compose up --build
curl localhost:3000/readyz
```

| Service       | URL                   | Notes                                             |
| ------------- | --------------------- | ------------------------------------------------- |
| Gateway       | http://localhost:3000 | `GET /healthz` (liveness), `GET /readyz` (deps)   |
| Mock provider | http://localhost:4000 | Fake upstream; provider endpoints land in GW-10.1 |
| Grafana       | http://localhost:3001 | Tempo, Prometheus, Loki and OTLP on 4317/4318     |
| Postgres      | localhost:5442        | Offset from 5432 to avoid clashing with local DBs |
| Redis         | localhost:6389        | Offset from 6379 for the same reason              |

Local models: `docker compose --profile local-models up` adds Ollama on port 11434.

Migrations run in the one-off `migrate` service before the gateway starts. The gateway never
migrates on boot.

## Development

```bash
pnpm install
pnpm lint              # ESLint + Prettier check
pnpm typecheck         # tsc --noEmit across every package
pnpm test              # unit tests
pnpm test:integration  # Postgres/Redis via Testcontainers (needs Docker)
```

Run the gateway from source against the compose databases:

```bash
docker compose up -d postgres redis migrate
set -a && . ./.env && set +a && pnpm --filter @gw/gateway dev
```

Change the schema in `packages/gateway/src/db/schema.ts`, then
`pnpm --filter @gw/gateway db:generate --name <change>` and review the generated SQL.

## Layout

```
packages/
  gateway/        Fastify data plane (/v1) and admin plane (/admin/v1); Drizzle schema + migrations
  mock-provider/  Fault-injecting fake upstream for tests, load tests and the public demo
  schema/         Shared Zod schemas and types (error envelope, canonical request)
  dashboard/      Next.js usage dashboard (scaffolded in GW-9.2)
```

Workspace packages resolve to TypeScript sources in dev and tests via the `@gw/source` export
condition, and to `dist` at runtime, so there is no build step during development.

## Design decisions so far

- **Money is integer micro-USD** (`bigint`) everywhere; no floating-point currency.
- **`usage_events` is range-partitioned by UTC month.** `ensure_usage_events_partition()` is
  called on demand when an insert lands in a month without a partition, so writes never fail on a
  month boundary.
- **Prices are append-only**; a partial unique index allows one open price per model.
- **Hard budgets reject with `402 budget_exceeded`** (no silent downgrade to cheaper models).
- **The public demo uses only the mock provider and zero-cost local models**: no real provider
  keys.

## Repository settings (manual)

Enable branch protection on `main` requiring the `lint`, `typecheck`, `unit`, `integration`,
`docker`, `commitlint` and `gitleaks` checks. Commit messages follow Conventional Commits.
