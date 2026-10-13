import { createHmac, hkdfSync } from 'node:crypto';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { schema, type Database } from './db/index.ts';

export interface Limit {
  max: number;
  windowMs: number;
}

export interface HitStore {
  /** Records a hit and returns 0, or returns the seconds until a hit would be allowed without recording. */
  consume(key: string, limit: Limit): Promise<number>;
  remaining(key: string, limit: Limit): Promise<number>;
}

export interface ResettableHitStore extends HitStore {
  reset(key: string): Promise<void>;
}

export function memoryHitStore(now?: () => number): ResettableHitStore {
  const limiter = new RateLimiter(now);
  return {
    consume: async (key, limit) => limiter.consume(key, limit),
    remaining: async (key, limit) => limiter.remaining(key, limit),
    reset: async (key) => limiter.reset(key),
  };
}

// Keys are hashed with a key derived from the secret (label "mail-limit") so the table never holds
// addresses or IPs. A per-key advisory lock serialises concurrent callers, so the count-then-insert
// cannot overshoot the limit across instances.
export function postgresHitStore({ db }: Database, secret: string): ResettableHitStore {
  const hmacKey = Buffer.from(hkdfSync('sha256', secret, '', 'mail-limit', 32));
  const hashed = (key: string) => createHmac('sha256', hmacKey).update(key).digest('hex');
  const windowSeconds = ({ windowMs }: Limit) => windowMs / 1000;
  const cutoff = (limit: Limit) => sql`now() - make_interval(secs => ${windowSeconds(limit)})`;
  const stats = {
    count: sql<number>`count(*)::int`,
    oldest: sql<number>`extract(epoch from min(${schema.mailLimitHits.at}))::float8`,
    now: sql<number>`extract(epoch from now())::float8`,
  };
  const retryAfter = (oldest: number, now: number, limit: Limit) =>
    Math.max(1, Math.ceil(oldest + windowSeconds(limit) - now));

  return {
    consume: (key, limit) =>
      db.transaction(async (tx) => {
        const k = hashed(key);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${k}, 0))`);
        await tx
          .delete(schema.mailLimitHits)
          .where(and(eq(schema.mailLimitHits.key, k), lte(schema.mailLimitHits.at, cutoff(limit))));
        const [row] = await tx
          .select(stats)
          .from(schema.mailLimitHits)
          .where(eq(schema.mailLimitHits.key, k));
        if (row && row.count >= limit.max) return retryAfter(row.oldest, row.now, limit);
        await tx.insert(schema.mailLimitHits).values({ key: k });
        return 0;
      }),
    async reset(key) {
      await db.delete(schema.mailLimitHits).where(eq(schema.mailLimitHits.key, hashed(key)));
    },
    async remaining(key, limit) {
      const [row] = await db
        .select(stats)
        .from(schema.mailLimitHits)
        .where(
          and(
            eq(schema.mailLimitHits.key, hashed(key)),
            gt(schema.mailLimitHits.at, cutoff(limit)),
          ),
        );
      if (!row || row.count < limit.max) return 0;
      return retryAfter(row.oldest, row.now, limit);
    },
  };
}

export class RateLimiter {
  private readonly hits = new Map<string, { times: number[]; windowMs: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Records a hit and returns 0, or returns the seconds until a hit would be allowed without recording. */
  consume(key: string, { max, windowMs }: Limit): number {
    const now = this.now();
    const recent = (this.hits.get(key)?.times ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, { times: recent, windowMs });
      const oldest = recent[0] ?? now;
      return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    }
    recent.push(now);
    this.hits.set(key, { times: recent, windowMs });
    this.sweep(now);
    return 0;
  }

  remaining(key: string, { max, windowMs }: Limit): number {
    const now = this.now();
    const recent = (this.hits.get(key)?.times ?? []).filter((t) => now - t < windowMs);
    if (recent.length < max) return 0;
    return Math.max(1, Math.ceil(((recent[0] ?? now) + windowMs - now) / 1000));
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number): void {
    if (this.hits.size < 1000) return;
    for (const [key, { times, windowMs }] of this.hits) {
      const last = times[times.length - 1];
      if (last === undefined || now - last >= windowMs) this.hits.delete(key);
    }
  }
}
