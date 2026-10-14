import type { Queue } from 'bullmq';
import type { UsageEvent } from './event.js';
import type { SpillFile } from './spill.js';

export interface UsageRecorder {
  /** Fire and forget: never blocks or fails the request. */
  record(event: UsageEvent): void;
}

export const noopRecorder: UsageRecorder = { record: () => {} };

type Logger = {
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

/** Queues usage events on BullMQ; spills to disk when the queue cannot be reached. */
export class QueueUsageRecorder implements UsageRecorder {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly queue: Pick<Queue<UsageEvent>, 'add'>,
    private readonly spill: SpillFile,
    private readonly log: Logger,
    private readonly enqueueTimeoutMs = 1000,
  ) {}

  record(event: UsageEvent): void {
    const task = this.enqueue(event).catch(async (err: unknown) => {
      this.log.warn(
        { err, requestId: event.requestId },
        'usage queue unavailable; spilling event to disk',
      );
      try {
        await this.spill.append(event);
      } catch (spillErr) {
        this.log.error(
          { err: spillErr, event },
          'usage event lost: queue and spill file both failed',
        );
      }
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  async enqueue(event: UsageEvent): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('usage enqueue timed out')), this.enqueueTimeoutMs);
    });
    try {
      // The job id makes re-enqueueing the same request (spill replay) a no-op while the job exists.
      await Promise.race([this.queue.add('usage', event, { jobId: event.requestId }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Re-queues spilled events; called on startup and periodically. */
  async replaySpill(): Promise<number> {
    return this.spill.drain((event) => this.enqueue(event));
  }

  /** Waits for in-flight enqueues (graceful shutdown, tests). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}
