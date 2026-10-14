# 7. Route virtual models to the cheapest eligible model

- Status: accepted
- Date: 2026-10-14

## Context and problem statement

Most requests do not need the most capable model. Teams should be able to ask for `auto` and get
the cheapest model that can actually serve the request, never a model that lacks a capability the
request needs, and the decision must be explainable to tenant admins and finance.

## Considered options

- Static fallback chains per virtual model only
- Learned or quality-scored routing (needs evaluation data the gateway does not have)
- Rule-based eligibility filtering, then ranking by expected cost

## Decision outcome

Chosen: **filter, then rank by expected cost**, behind `ff_cost_aware_routing`. A model is
eligible when it is enabled and routable, meets the request's capabilities (tools, vision, JSON
mode, streaming, context window) and the policy's quality and latency tiers (explicit `gateway`
fields override the policy), has a credential and an endpoint, and fits `max_cost_usd` at worst
case. Eligible models are ranked by expected cost (prompt estimate × input price + output
allowance × output price); the cheapest three form the fallback chain. The decision is returned
in `x-gateway-route-reason` and stored on the usage event. Concrete model names are never
substituted.

## Consequences

- Good: savings come without application changes, and every choice is explained.
- Good: the existing retry and fallback engine handles provider failures within the chain.
- Bad: ranking ignores quality beyond the tier floor; a cheaper model of the same tier always wins.
- Bad: ties use the static latency tier until observed p95 latency is available (GW-8.2), and a
  configured-but-down provider stays in the chain until the circuit breaker exists (GW-3.3).
