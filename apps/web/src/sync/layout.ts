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
  private epoch = 0;
  private edited = false;

  constructor(private readonly options: LayoutSaverOptions) {}

  submit(tankId: string, layout: DecorLayout): void {
    if (this.disposed) return;
    this.pending.set(tankId, layout);
    this.edited = true;
    this.failed = null;
    this.options.report('saving', null);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.debounceMs ?? DEBOUNCE_MS);
  }

  get busy(): boolean {
    return (
      this.timer !== null ||
      this.running !== null ||
      this.pending.size > 0 ||
      this.failed !== null
    );
  }

  /** Drops queued and failed saves, e.g. at sign-out, so nothing outlives the session that made it. */
  reset(): void {
    this.epoch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.failed = null;
    this.edited = false;
    this.options.report('idle', null);
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
      const epoch = this.epoch;
      try {
        await withRetry(
          () => {
            if (epoch !== this.epoch) throw new SessionEnded();
            return this.options.send(tankId, layout);
          },
          {
            sleep: this.options.sleep ?? realSleep,
            maxAttempts: this.options.maxAttempts ?? 4,
          },
        );
      } catch (error) {
        if (epoch !== this.epoch) continue;
        if (!this.pending.has(tankId)) this.failed = { tankId, layout };
        this.options.report('error', describeSyncError(error));
      }
    }
    if (!this.failed && this.edited) this.options.report('saved', null);
  }
}

class SessionEnded extends Error {}
