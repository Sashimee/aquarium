import type { DecorLayout } from '@aquarium/shared';
import type { SaveStatus } from '../interaction/events';
import { withRetry, realSleep, type Sleep } from './backoff';
import { describeSyncError } from './messages';

export interface LayoutSaverOptions {
  send(tankId: string, layout: DecorLayout): Promise<void>;
  report(status: SaveStatus, message: string | null): void;
  debounceMs?: number | undefined;
  sleep?: Sleep;
  maxAttempts?: number;
}

const DEBOUNCE_MS = 700;

/**
 * Saves the newest layout per tank. Edits arrive in bursts (nudge, nudge, rotate), so it waits a
 * moment, sends only the latest, and sends one request at a time so the server sees them in order.
 */
export class LayoutSaver {
  private readonly pending = new Map<string, DecorLayout>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private failed: { tankId: string; layout: DecorLayout } | null = null;
  private disposed = false;

  constructor(private readonly options: LayoutSaverOptions) {}

  submit(tankId: string, layout: DecorLayout): void {
    if (this.disposed) return;
    this.pending.set(tankId, layout);
    this.failed = null;
    this.options.report('saving', null);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.debounceMs ?? DEBOUNCE_MS);
  }

  get busy(): boolean {
    return this.timer !== null || this.running !== null || this.pending.size > 0;
  }

  retry(): void {
    const failed = this.failed;
    if (failed) this.submit(failed.tankId, failed.layout);
  }

  /** Sends whatever is waiting now; resolves once nothing is waiting or in flight. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  dispose(): void {
    if (this.disposed) return;
    const settled = this.flush();
    this.disposed = true;
    settled.catch(() => undefined);
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = this.pending.entries().next();
      if (next.done) break;
      const [tankId, layout] = next.value;
      this.pending.delete(tankId);
      try {
        await withRetry(() => this.options.send(tankId, layout), {
          sleep: this.options.sleep ?? realSleep,
          maxAttempts: this.options.maxAttempts ?? 4,
        });
      } catch (error) {
        if (!this.pending.has(tankId)) this.failed = { tankId, layout };
        this.options.report('error', describeSyncError(error));
      }
    }
    if (!this.failed) this.options.report('saved', null);
  }
}
