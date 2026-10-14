import { FEEDING_WINDOW_MINUTES } from '@aquarium/sim/lifecycle';
import type { AteReport } from '@aquarium/shared';
import { AteBatcher, type AteBatcherOptions } from './ateBatcher';
import { isTransient, realSleep, withRetry, type Sleep } from './backoff';

export type DropReason = 'rejected' | 'gave-up' | 'expired' | 'unsupported';

export interface AteUploaderOptions {
  send(reports: AteReport[], batchId: string): Promise<void>;
  /** Called when reports are discarded for good, so the UI can say so instead of failing silently. */
  onDropped?(reason: DropReason, reports: readonly AteReport[], cause?: unknown): void;
  intervalMs?: number;
  maxAttempts?: number;
  /** Reports older than this are refused by the server's feeding window anyway. */
  maxAgeMs?: number;
  now?: () => Date;
  sleep?: Sleep;
  random?: () => number;
  timers?: AteBatcherOptions['timers'];
}

/**
 * Batches `ate` reports and delivers them with backoff. The queue is bounded three ways: the
 * batcher keeps one entry per fish, a batch never exceeds the server limit, and a report is
 * dropped once it is older than the feeding window or has used up its attempts.
 */
export class AteUploader {
  private readonly batcher: AteBatcher;
  private readonly abort = new AbortController();
  private readonly now: () => Date;
  private readonly maxAgeMs: number;
  private delivering: Promise<void> | null = null;
  private lost = false;

  constructor(private readonly options: AteUploaderOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxAgeMs = options.maxAgeMs ?? FEEDING_WINDOW_MINUTES * 60_000;
    this.batcher = new AteBatcher({
      flush: (batch) => this.deliver(batch),
      ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
      now: this.now,
      ...(options.timers ? { timers: options.timers } : {}),
    });
  }

  get size(): number {
    return this.batcher.size;
  }

  add(fishId: string, portion: number): void {
    this.batcher.add(fishId, portion);
  }

  /** Nothing queued, nothing mid-delivery and nothing given up on. */
  get settled(): boolean {
    return this.batcher.size === 0 && this.delivering === null && !this.lost;
  }

  /** Also waits for a delivery the periodic timer already has in flight, which the batcher skips. */
  async flushNow(): Promise<void> {
    await this.batcher.flushNow();
    while (this.delivering) await this.delivering;
  }

  dispose(): void {
    this.abort.abort();
    this.batcher.dispose();
  }

  private fresh(batch: readonly AteReport[]): AteReport[] {
    const cutoff = this.now().getTime() - this.maxAgeMs;
    return batch.filter((r) => Date.parse(r.at) >= cutoff);
  }

  private deliver(batch: AteReport[]): Promise<void> {
    const run = this.attempt(batch).finally(() => {
      if (this.delivering === run) this.delivering = null;
    });
    this.delivering = run;
    return run;
  }

  private async attempt(batch: AteReport[]): Promise<void> {
    const { send, onDropped } = this.options;
    if (typeof crypto.randomUUID !== 'function') {
      this.lost = true;
      // randomUUID exists only in secure contexts, so plain http on a LAN IP lands here.
      onDropped?.(
        'unsupported',
        batch,
        new Error('crypto.randomUUID is unavailable (insecure context); serve the app over https'),
      );
      return;
    }
    const batchId = crypto.randomUUID();
    let remaining = batch;
    const prune = () => {
      const live = this.fresh(remaining);
      if (live.length < remaining.length) {
        onDropped?.(
          'expired',
          remaining.filter((r) => !live.includes(r)),
        );
      }
      remaining = live;
    };
    try {
      await withRetry(
        async () => {
          prune();
          if (remaining.length > 0) await send(remaining, batchId);
        },
        {
          maxAttempts: this.options.maxAttempts ?? 12,
          sleep: this.options.sleep ?? realSleep,
          signal: this.abort.signal,
          ...(this.options.random ? { random: this.options.random } : {}),
        },
      );
    } catch (cause) {
      this.lost = true;
      if (this.abort.signal.aborted) return;
      onDropped?.(isTransient(cause) ? 'gave-up' : 'rejected', remaining, cause);
    }
  }
}
