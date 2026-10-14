import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { UsageEvent } from './event.js';

/**
 * Append-only NDJSON file for usage events that could not be queued (Redis down). Replayed into
 * the queue on startup and periodically, so no request goes unrecorded.
 */
export class SpillFile {
  constructor(readonly file: string) {}

  async append(event: UsageEvent): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(event)}\n`, { flag: 'a' });
  }

  async size(): Promise<number> {
    try {
      return (await stat(this.file)).size;
    } catch {
      return 0;
    }
  }

  /**
   * Hands every spilled event to `handler`. The file is moved aside first so new spills can keep
   * appending; events the handler rejects are written back. Returns how many were replayed.
   */
  async drain(handler: (event: UsageEvent) => Promise<void>): Promise<number> {
    if ((await this.size()) === 0) return 0;
    const replaying = `${this.file}.replaying-${process.pid}-${Date.now()}`;
    await rename(this.file, replaying);
    const lines = (await readFile(replaying, 'utf8')).split('\n').filter(Boolean);
    let replayed = 0;
    for (const [i, line] of lines.entries()) {
      try {
        await handler(JSON.parse(line) as UsageEvent);
        replayed++;
      } catch {
        for (const rest of lines.slice(i)) await appendFile(this.file, `${rest}\n`);
        break;
      }
    }
    await rm(replaying, { force: true });
    return replayed;
  }
}
