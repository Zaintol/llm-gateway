# 1. TypeScript on Node.js with Fastify for the gateway

- Status: accepted
- Date: 2026-10-14

## Context and problem statement

The gateway proxies streaming HTTP between clients and LLM providers, translates between several
JSON wire formats, and shares types with a web dashboard. It is built by one engineer, so the
stack must keep the request path fast and the codebase small. Python (FastAPI) was the main
alternative and is common in AI infrastructure roles.

## Considered options

- TypeScript on Node.js 22 with Fastify and Zod
- Python with FastAPI, httpx and Pydantic
- Go with net/http

## Decision outcome

Chosen: **TypeScript with Fastify**. Streaming server-sent events and back-pressure are native to
Node; Fastify's hook model maps cleanly onto the pipeline (auth, validation, rate limit, route,
budget, execute, meter); and one language spans the gateway, the mock provider, the shared Zod
schemas and the Next.js dashboard. Zod schemas double as runtime validation, TypeScript types and
the generated OpenAPI reference.

## Consequences

- Good: one schema package (`@gw/schema`) is the single source of truth for the wire format.
- Good: the official OpenAI SDK for Node is used directly in end-to-end tests.
- Bad: CPU-heavy work (tokenisation) shares the event loop; it is kept small (tiktoken only for
  admission estimates) and would move to a worker thread if it showed up in profiles.
- Bad: the Python AI ecosystem (tokenizers, eval tooling) is not available in-process.
