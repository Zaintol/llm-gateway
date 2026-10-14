# 4. Fall back only before the first streamed byte

- Status: accepted
- Date: 2026-10-14

## Context and problem statement

Streaming responses are flushed to the client as they arrive. If a provider fails mid-stream,
switching to another model would splice two different completions into one answer, and a
different model's output is not a continuation of the first.

## Considered options

- Buffer the whole stream and fall back transparently (defeats streaming)
- Fall back at any point and restart the answer (the client sees duplicated or contradictory text)
- Fall back only until the first event; afterwards, end the stream with an error

## Decision outcome

Chosen: **commit on the first event**. Until a candidate produces its first event within the
first-token timeout, the normal retry and fallback rules apply and errors return as JSON with a
status code. After that, a provider failure or an idle gap ends the stream with an error chunk
and `[DONE]`, and the usage is metered as `partial` (or `client_cancelled` when the client left).

## Consequences

- Good: clients never receive spliced output; the OpenAI SDK surfaces the error chunk as an error.
- Good: time to first token is protected by its own timeout, independent of total generation time.
- Bad: a provider that fails late in a long answer costs the client a retry.
- Bad: partial streams are billed from an estimate when the provider sends no final usage.
