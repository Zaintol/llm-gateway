# 3. Version prices append-only and store money as integer micro-USD

- Status: accepted
- Date: 2026-10-14

## Context and problem statement

Provider prices change. Historical spend reports must not change when they do, and cost must be
exact enough to reconcile against invoices. Floating-point currency accumulates rounding error,
and a typical request costs fractions of a cent.

## Considered options

- One price column per model, updated in place, stored as a float
- `numeric` money columns with in-place updates
- Append-only price rows with effective dates, money as integer micro-USD (bigint)

## Decision outcome

Chosen: **append-only, versioned prices in integer micro-USD**. `catalog/models.yaml` is the
reviewed source; the seed command closes the open price row and inserts a new one when a price
changes. Each usage event stores the `price_id` it was costed with, and requests are priced at
the row in effect when they started. Prices are micro-USD per million tokens, so a request's cost
is an exact integer sum with one division at the end, rounded half-to-even.

## Consequences

- Good: re-pricing never rewrites history; every cost is traceable to a price row and its source URL.
- Good: no floating point in money paths; totals in the dashboard equal the database sums.
- Bad: sub-micro-USD precision is not representable (the validator rejects such prices).
- Bad: price rows accumulate forever (a few per model per year, negligible).
