export interface Limit {
  max: number;
  windowMs: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Records a hit and returns 0, or returns the seconds until a hit would be allowed without recording. */
  consume(key: string, { max, windowMs }: Limit): number {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    }
    recent.push(now);
    this.hits.set(key, recent);
    this.sweep(now, windowMs);
    return 0;
  }

  remaining(key: string, { max, windowMs }: Limit): number {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length < max) return 0;
    return Math.max(1, Math.ceil(((recent[0] ?? now) + windowMs - now) / 1000));
  }

  private sweep(now: number, windowMs: number): void {
    if (this.hits.size < 1000) return;
    for (const [key, times] of this.hits) {
      const last = times[times.length - 1];
      if (last === undefined || now - last >= windowMs) this.hits.delete(key);
    }
  }
}
