import { MIN_ATE_PORTION, type AteReport } from '@aquarium/shared';

export interface AteBatcherOptions {
  /** Called with at most `maxPerBatch` reports; a rejected promise puts them back in the queue. */
  flush(reports: AteReport[]): Promise<void>;
  /** Milliseconds a report may wait for company before it is sent. */
  intervalMs?: number;
  maxPerBatch?: number;
  now?: () => Date;
  timers?: {
    setTimeout(cb: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

const MAX_PORTION = 10;

/** Merges `ate` events per fish and sends them in batches the server accepts. */
export class AteBatcher {
  private readonly pending = new Map<string, { portion: number; at: Date }>();
  private handle: unknown = null;
  private flushing = false;
  private disposed = false;
  private readonly intervalMs: number;
  private readonly maxPerBatch: number;
  private readonly now: () => Date;
  private readonly timers: NonNullable<AteBatcherOptions['timers']>;

  constructor(private readonly options: AteBatcherOptions) {
    this.intervalMs = options.intervalMs ?? 5_000;
    this.maxPerBatch = options.maxPerBatch ?? 200;
    this.now = options.now ?? (() => new Date());
    this.timers = options.timers ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  get size(): number {
    return this.pending.size;
  }

  add(fishId: string, portion: number): void {
    this.queue(fishId, portion, this.now());
  }

  private queue(fishId: string, portion: number, at: Date): void {
    if (this.disposed || !(portion > 0)) return;
    const entry = this.pending.get(fishId);
    if (entry) {
      entry.portion += portion;
      if (at < entry.at) entry.at = at;
    } else {
      this.pending.set(fishId, { portion, at });
    }
    this.schedule();
  }

  /** Sends everything queued; rejects if the sender does, after re-queueing that batch. */
  async flushNow(): Promise<void> {
    if (this.flushing || this.disposed) return;
    this.cancelTimer();
    this.flushing = true;
    try {
      while (this.pending.size > 0) {
        const batch = this.takeBatch();
        if (batch.length === 0) break;
        try {
          await this.options.flush(batch);
        } catch (cause) {
          for (const r of batch) this.queue(r.fishId, r.portion, new Date(r.at));
          throw cause;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.pending.clear();
  }

  private takeBatch(): AteReport[] {
    const batch: AteReport[] = [];
    for (const [fishId, entry] of this.pending) {
      if (batch.length >= this.maxPerBatch) break;
      this.pending.delete(fishId);
      if (entry.portion < MIN_ATE_PORTION) continue;
      batch.push({
        fishId,
        portion: Math.min(MAX_PORTION, entry.portion),
        at: entry.at.toISOString(),
      });
    }
    return batch;
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.handle !== null) return;
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      this.flushNow().catch((cause: unknown) => console.error('ate report failed', cause));
    }, this.intervalMs);
  }

  private cancelTimer(): void {
    if (this.handle === null) return;
    this.timers.clearTimeout(this.handle);
    this.handle = null;
  }
}
