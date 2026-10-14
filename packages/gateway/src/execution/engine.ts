import type { ChatCompletionRequest } from '@gw/schema';
import { ProviderError, type ProviderErrorKind } from '../providers/errors.js';
import type { ProviderResult, StreamEvent } from '../providers/types.js';
import type { Candidate } from '../routing/planner.js';

export type AttemptRecord = {
  model: string;
  provider: string;
  /** 1-based attempt number for this candidate. */
  attempt: number;
  outcome: 'success' | ProviderErrorKind;
  upstreamStatus?: number;
  durationMs: number;
};

export type ExecutionSuccess = {
  result: ProviderResult;
  served: Candidate;
  attempts: AttemptRecord[];
};

/**
 * A stream that has produced its first event. From here on the response is committed to this
 * candidate: later failures cannot fall back, because bytes have reached the client.
 */
export type StreamSuccess = {
  served: Candidate;
  attempts: AttemptRecord[];
  first: StreamEvent;
  rest: AsyncIterator<StreamEvent>;
  /** Aborts the upstream request (client disconnect, idle timeout). */
  abort: (reason?: unknown) => void;
};

export type CandidateFailure = { candidate: Candidate; error: ProviderError; attempts: number };

/** Every candidate failed, or the deadline ran out. */
export class ExecutionFailure extends Error {
  constructor(
    readonly failures: CandidateFailure[],
    readonly attempts: AttemptRecord[],
    readonly deadlineExceeded: boolean,
    /** Set when a candidate returned an error no other provider could fix (invalid_request). */
    readonly terminal?: ProviderError,
  ) {
    super('execution failed');
    this.name = 'ExecutionFailure';
  }
}

export type EngineOptions = {
  /** Retries per candidate after the first attempt. */
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Upper bound for one non-streaming attempt; the remaining deadline may cut it shorter. */
  attemptTimeoutMs?: number;
  /** Streaming: how long to wait for the first event before abandoning the attempt. */
  firstTokenTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs a request across an ordered candidate chain:
 * - each attempt gets min(attemptTimeoutMs, remaining deadline);
 * - retryable errors are retried on the same candidate with full-jitter exponential backoff,
 *   honouring Retry-After when it fits in the deadline (otherwise moving straight on);
 * - non-retryable but fallback-eligible errors (e.g. bad credentials) move to the next candidate;
 * - invalid_request stops everything, since every provider would reject the same request.
 */
export class ExecutionEngine {
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly firstTokenTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: EngineOptions = {}) {
    this.maxRetries = options.maxRetries ?? 2;
    this.backoffBaseMs = options.backoffBaseMs ?? 200;
    this.backoffCapMs = options.backoffCapMs ?? 2000;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 60_000;
    this.firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? 20_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /** Full jitter: uniform in [0, min(cap, base * 2^retry)]. */
  backoff(retry: number): number {
    return Math.floor(this.random() * Math.min(this.backoffCapMs, this.backoffBaseMs * 2 ** retry));
  }

  execute(
    request: ChatCompletionRequest,
    candidates: Candidate[],
    deadlineAt: number,
    signal?: AbortSignal,
  ): Promise<ExecutionSuccess> {
    return this.run(
      candidates,
      deadlineAt,
      signal,
      async (candidate, remainingMs, attemptSignal) => {
        const result = await candidate.adapter.complete(request, {
          upstreamModel: candidate.upstreamModel,
          credential: candidate.credential,
          signal: AbortSignal.any([
            AbortSignal.timeout(Math.min(this.attemptTimeoutMs, remainingMs)),
            attemptSignal,
          ]),
          ...(candidate.model ? { maxOutputTokens: candidate.model.maxOutputTokens } : {}),
        });
        return { result };
      },
    ).then(({ value, served, attempts }) => ({ result: value.result, served, attempts }));
  }

  /**
   * Opens a stream on the first candidate that produces an event within the first-token timeout.
   * Retries and fallback apply only until that first event.
   */
  executeStream(
    request: ChatCompletionRequest,
    candidates: Candidate[],
    deadlineAt: number,
    signal?: AbortSignal,
  ): Promise<StreamSuccess> {
    return this.run(
      candidates,
      deadlineAt,
      signal,
      async (candidate, remainingMs, attemptSignal) => {
        const controller = new AbortController();
        const onAbort = () => controller.abort(attemptSignal.reason);
        attemptSignal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(
          () => controller.abort(),
          Math.min(this.firstTokenTimeoutMs, remainingMs),
        );
        const iterator = candidate.adapter
          .stream(request, {
            upstreamModel: candidate.upstreamModel,
            credential: candidate.credential,
            signal: controller.signal,
            ...(candidate.model ? { maxOutputTokens: candidate.model.maxOutputTokens } : {}),
          })
          [Symbol.asyncIterator]();
        try {
          const first = await iterator.next();
          if (first.done) {
            throw new ProviderError(
              'provider_error',
              candidate.provider,
              `${candidate.provider} returned an empty stream`,
            );
          }
          return {
            first: first.value,
            rest: iterator,
            abort: (reason?: unknown) => controller.abort(reason),
          };
        } catch (err) {
          controller.abort();
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
    ).then(({ value, served, attempts }) => ({ ...value, served, attempts }));
  }

  /**
   * The retry and fallback loop shared by both modes. `attempt` receives the remaining deadline
   * and a signal that fires if the caller gives up (client disconnect).
   */
  private async run<T>(
    candidates: Candidate[],
    deadlineAt: number,
    signal: AbortSignal | undefined,
    attempt: (candidate: Candidate, remainingMs: number, signal: AbortSignal) => Promise<T>,
  ): Promise<{ value: T; served: Candidate; attempts: AttemptRecord[] }> {
    const attempts: AttemptRecord[] = [];
    const failures: CandidateFailure[] = [];
    const remaining = () => deadlineAt - this.now();
    const callerSignal = signal ?? new AbortController().signal;

    for (const candidate of candidates) {
      let lastError: ProviderError | undefined;
      let tries = 0;
      for (let retry = 0; retry <= this.maxRetries; retry++) {
        if (remaining() <= 0 || callerSignal.aborted) break;
        const started = this.now();
        tries++;
        try {
          const value = await attempt(candidate, remaining(), callerSignal);
          attempts.push(record(candidate, retry, 'success', this.now() - started));
          return { value, served: candidate, attempts };
        } catch (err) {
          if (!(err instanceof ProviderError)) throw err;
          lastError = err;
          attempts.push(
            record(candidate, retry, err.kind, this.now() - started, err.upstreamStatus),
          );

          if (!err.fallbackEligible) {
            throw new ExecutionFailure(
              [...failures, { candidate, error: err, attempts: tries }],
              attempts,
              false,
              err,
            );
          }
          if (!err.retryable || retry === this.maxRetries) break;

          let delay = this.backoff(retry);
          if (err.retryAfterSeconds !== undefined) {
            const retryAfterMs = err.retryAfterSeconds * 1000;
            // Waiting longer than the deadline allows is pointless: move to the next candidate.
            if (retryAfterMs >= remaining()) break;
            delay = Math.max(delay, retryAfterMs);
          }
          if (delay >= remaining()) break;
          await this.sleep(delay);
        }
      }
      if (lastError) failures.push({ candidate, error: lastError, attempts: tries });
      if (remaining() <= 0 || callerSignal.aborted) break;
    }
    throw new ExecutionFailure(failures, attempts, remaining() <= 0);
  }
}

function record(
  candidate: Candidate,
  retry: number,
  outcome: AttemptRecord['outcome'],
  durationMs: number,
  upstreamStatus?: number,
): AttemptRecord {
  return {
    model: candidate.id,
    provider: candidate.provider,
    attempt: retry + 1,
    outcome,
    durationMs,
    ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
  };
}
