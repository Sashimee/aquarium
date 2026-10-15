export interface FeedGateOptions {
  /** Mirrors the server's feed limit (20 per 10 minutes) so the UI refuses before the API does. */
  max?: number;
  windowMs?: number;
  /** Minimum gap between two feeds. */
  cooldownMs?: number;
}

export type FeedDecision = { ok: true } | { ok: false; retryAfterMs: number };

export class FeedGate {
  private readonly stamps: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;

  constructor(options: FeedGateOptions = {}) {
    this.max = options.max ?? 20;
    this.windowMs = options.windowMs ?? 10 * 60_000;
    this.cooldownMs = options.cooldownMs ?? 1_500;
  }

  /** Records the feed when allowed. `nowMs` is any monotonic clock. */
  tryFeed(nowMs: number): FeedDecision {
    while (this.stamps.length > 0 && nowMs - (this.stamps[0] ?? 0) >= this.windowMs) {
      this.stamps.shift();
    }
    const last = this.stamps[this.stamps.length - 1];
    if (last !== undefined && nowMs - last < this.cooldownMs) {
      return { ok: false, retryAfterMs: this.cooldownMs - (nowMs - last) };
    }
    const first = this.stamps[0];
    if (this.stamps.length >= this.max && first !== undefined) {
      return { ok: false, retryAfterMs: this.windowMs - (nowMs - first) };
    }
    this.stamps.push(nowMs);
    return { ok: true };
  }

  /** Gives back the slot `tryFeed(nowMs)` took, for a feed that ended up posting nothing. */
  release(nowMs: number): void {
    const at = this.stamps.lastIndexOf(nowMs);
    if (at !== -1) this.stamps.splice(at, 1);
  }
}
