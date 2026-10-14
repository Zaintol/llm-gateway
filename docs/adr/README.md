# Architecture decision records

Format: [MADR](https://adr.github.io/madr/). Each record covers context, the options considered,
the decision, and its consequences.

| #                                                       | Decision                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| [0001](0001-typescript-fastify.md)                      | TypeScript on Node.js with Fastify for the gateway                |
| [0002](0002-budget-atomicity-redis-lua.md)              | Enforce hard budgets with reserve-and-settle Lua scripts in Redis |
| [0003](0003-versioned-prices-integer-micros.md)         | Version prices append-only and store money as integer micro-USD   |
| [0004](0004-streaming-fallback-semantics.md)            | Fall back only before the first streamed byte                     |
| [0005](0005-provider-credential-envelope-encryption.md) | Envelope-encrypt provider credentials with a versioned master key |
| [0006](0006-async-metering.md)                          | Persist usage asynchronously through a queue, idempotently        |
| [0007](0007-cost-aware-routing.md)                      | Route virtual models to the cheapest eligible model               |
