import {
  galleryQuerySchema,
  galleryResponseSchema,
  galleryWeekEnd,
  galleryWeekStart,
  galleryWinnersResponseSchema,
  GALLERY_WINNER_HISTORY,
  voteRequestSchema,
  voteStateSchema,
} from '@aquarium/shared';
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from './audit.ts';
import { schema, type Database } from './db/index.ts';
import { apiError } from './errors.ts';
import { publicName, type PublicRoutes } from './public.ts';
import type { Limit, RateLimiter } from './rate-limit.ts';
import { storedBackground, type SessionUser } from './tanks.ts';
import { normalizedPathname } from './url.ts';

export interface GalleryLimits {
  view: Limit;
  vote: Limit;
  voteIp: Limit;
}

export const DEFAULT_GALLERY_LIMITS: GalleryLimits = {
  view: { max: 120, windowMs: 60_000 },
  vote: { max: 20, windowMs: 10 * 60_000 },
  voteIp: { max: 60, windowMs: 10 * 60_000 },
};

export interface GalleryRouteDeps {
  app: FastifyInstance;
  database: Database;
  limiter: RateLimiter;
  limits: GalleryLimits;
  now: () => number;
  snapshot: PublicRoutes['snapshot'];
  currentUser: (req: FastifyRequest) => Promise<SessionUser | null>;
}

const paramsSchema = z.object({ tankId: z.uuid() });

const WEEK_MS = 7 * 24 * 3_600_000;

type Executor = Pick<Database['db'], 'select'>;

// The gallery is a second opt-in on top of the public link; revoking the link clears it.
const listed = and(
  isNotNull(schema.tanks.shareTokenHash),
  eq(schema.tanks.inGallery, true),
  eq(schema.tanks.quarantine, false),
);

const votesIn = (week: string) =>
  sql<number>`(select count(*)::int from ${schema.tankVotes} v where v.tank_id = ${schema.tanks.id} and v.week_start = ${week}::timestamptz)`;

const livingFish = sql<number>`(select count(*)::int from ${schema.fish} f where f.tank_id = ${schema.tanks.id} and f.status = 'alive')`;

// Ties on votes go to the tank that reached its count first, then to the lower tank id, so the
// order never depends on row order or on who asks.
const lastVoteIn = (week: string) =>
  sql`(select max(v.created_at) from ${schema.tankVotes} v where v.tank_id = ${schema.tanks.id} and v.week_start = ${week}::timestamptz) asc nulls last`;

/**
 * Settles every finished week (up to the history window) that has votes but no row yet. A tank
 * that left the gallery before the week was settled cannot win; a week with no eligible tank is
 * recorded with no winner so it is never decided again.
 */
export async function settleWeeks({ db }: Database, nowMs: number): Promise<number> {
  const current = galleryWeekStart(nowMs);
  const oldest = new Date(Date.parse(current) - GALLERY_WINNER_HISTORY * WEEK_MS).toISOString();
  const result = await db.execute(sql`
    insert into ${schema.tankOfWeek} (week_start, tank_id, votes)
    select pending.week_start, best.tank_id, coalesce(best.n, 0)
    from (
      select distinct v.week_start
      from ${schema.tankVotes} v
      where v.week_start < ${current}::timestamptz
        and v.week_start >= ${oldest}::timestamptz
        and not exists (select 1 from ${schema.tankOfWeek} w where w.week_start = v.week_start)
    ) pending
    left join lateral (
      select v.tank_id, count(*)::int as n
      from ${schema.tankVotes} v
      join ${schema.tanks} t on t.id = v.tank_id
      where v.week_start = pending.week_start
        and t.share_token_hash is not null
        and t.in_gallery
        and not t.quarantine
      group by v.tank_id
      order by n desc, max(v.created_at) asc, v.tank_id asc
      limit 1
    ) best on true
    on conflict (week_start) do nothing
  `);
  return result.rowCount ?? 0;
}

export function registerGalleryRoutes({
  app,
  database,
  limiter,
  limits,
  now,
  snapshot,
  currentUser,
}: GalleryRouteDeps): void {
  const { db } = database;

  app.addHook('onSend', async (req, reply) => {
    if (!normalizedPathname(req.url).toLowerCase().startsWith('/api/gallery')) return;
    reply.header('x-robots-tag', 'noindex, nofollow').header('cache-control', 'no-store');
  });

  const throttled = (reply: FastifyReply, wait: number) =>
    reply
      .code(429)
      .header('retry-after', String(wait))
      .send(apiError('rate_limited', `Too many requests. Try again in ${wait} s.`));

  const notFound = (reply: FastifyReply) =>
    reply.code(404).send(apiError('not_found', 'This tank is not in the gallery.'));

  const weekNow = () => {
    const weekStart = galleryWeekStart(now());
    return { weekStart, weekEnd: galleryWeekEnd(weekStart) };
  };

  async function myVote(executor: Executor, userId: string | null, weekStart: string) {
    if (userId === null) return null;
    const [row] = await executor
      .select({ tankId: schema.tankVotes.tankId })
      .from(schema.tankVotes)
      .innerJoin(schema.tanks, eq(schema.tanks.id, schema.tankVotes.tankId))
      .where(
        and(
          eq(schema.tankVotes.userId, userId),
          eq(schema.tankVotes.weekStart, new Date(weekStart)),
          listed,
        ),
      );
    return row?.tankId ?? null;
  }

  app.get('/api/gallery', async (req, reply) => {
    const wait = limiter.consume(`gallery-view:${req.ip}`, limits.view);
    if (wait > 0) return throttled(reply, wait);
    const { limit, offset } = galleryQuerySchema.parse(req.query);
    const viewer = await currentUser(req);
    const { weekStart, weekEnd } = weekNow();
    const votes = votesIn(weekStart);
    const [rows, [count], voted] = await Promise.all([
      db
        .select({ tank: schema.tanks, votes, fishCount: livingFish })
        .from(schema.tanks)
        .where(listed)
        .orderBy(desc(votes), lastVoteIn(weekStart), asc(schema.tanks.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.tanks)
        .where(listed),
      myVote(db, viewer?.id ?? null, weekStart),
    ]);
    return galleryResponseSchema.parse({
      weekStart,
      weekEnd,
      total: count?.n ?? 0,
      entries: rows.map(({ tank, votes: n, fishCount }) => ({
        id: tank.id,
        name: publicName(tank.name),
        biome: tank.biome,
        size: tank.size,
        backgroundId: storedBackground(tank),
        roomId: tank.roomId,
        fishCount,
        votes: n,
        mine: viewer?.id === tank.ownerId,
        voted: voted === tank.id,
      })),
      myVote: voted,
    });
  });

  app.get('/api/gallery/winners', async (req, reply) => {
    const wait = limiter.consume(`gallery-view:${req.ip}`, limits.view);
    if (wait > 0) return throttled(reply, wait);
    await settleWeeks(database, now());
    const rows = await db
      .select({
        tank: schema.tanks,
        weekStart: schema.tankOfWeek.weekStart,
        votes: schema.tankOfWeek.votes,
        fishCount: livingFish,
      })
      .from(schema.tankOfWeek)
      .innerJoin(schema.tanks, eq(schema.tanks.id, schema.tankOfWeek.tankId))
      .where(listed)
      .orderBy(desc(schema.tankOfWeek.weekStart))
      .limit(GALLERY_WINNER_HISTORY);
    return galleryWinnersResponseSchema.parse({
      winners: rows.map(({ tank, weekStart, votes, fishCount }) => ({
        id: tank.id,
        name: publicName(tank.name),
        biome: tank.biome,
        size: tank.size,
        backgroundId: storedBackground(tank),
        roomId: tank.roomId,
        fishCount,
        weekStart: weekStart.toISOString(),
        weekEnd: galleryWeekEnd(weekStart.toISOString()),
        votes,
      })),
    });
  });

  app.get('/api/gallery/:tankId', async (req, reply) => {
    const wait = limiter.consume(`gallery-view:${req.ip}`, limits.view);
    if (wait > 0) return throttled(reply, wait);
    const { tankId } = paramsSchema.parse(req.params);
    const [tank] = await db
      .select()
      .from(schema.tanks)
      .where(and(eq(schema.tanks.id, tankId), listed));
    if (!tank) return notFound(reply);
    return snapshot(tank, (await currentUser(req))?.id ?? null);
  });

  async function voter(req: FastifyRequest, reply: FastifyReply) {
    const user = await currentUser(req);
    if (!user) {
      reply.code(401).send(apiError('unauthenticated', 'Sign in to vote.'));
      return null;
    }
    if (!user.emailVerified) {
      reply
        .code(403)
        .send(apiError('email_not_verified', 'Verify your email address before voting.'));
      return null;
    }
    const wait = Math.max(
      limiter.consume(`gallery-vote:${user.id}`, limits.vote),
      limiter.consume(`gallery-vote-ip:${req.ip}`, limits.voteIp),
    );
    if (wait > 0) {
      throttled(reply, wait);
      return null;
    }
    return user;
  }

  app.put('/api/gallery/vote', async (req, reply) => {
    const user = await voter(req, reply);
    if (!user) return reply;
    const { tankId } = voteRequestSchema.parse(req.body);
    const outcome = await db.transaction(async (tx) => {
      const { weekStart, weekEnd } = weekNow();
      const at = new Date(now());
      // FOR SHARE makes a concurrent revoke wait, so a vote never lands on a tank that just went private.
      const [tank] = await tx
        .select({ id: schema.tanks.id, ownerId: schema.tanks.ownerId })
        .from(schema.tanks)
        .where(and(eq(schema.tanks.id, tankId), listed))
        .for('share');
      if (!tank) return 'not_found' as const;
      if (tank.ownerId === user.id) return 'own' as const;
      const changed = await tx
        .insert(schema.tankVotes)
        .values({ userId: user.id, weekStart: new Date(weekStart), tankId, createdAt: at })
        .onConflictDoUpdate({
          target: [schema.tankVotes.userId, schema.tankVotes.weekStart],
          set: { tankId, createdAt: at },
          setWhere: sql`${schema.tankVotes.tankId} <> excluded.tank_id`,
        })
        .returning({ tankId: schema.tankVotes.tankId });
      if (changed.length > 0) {
        await audit(tx, { action: 'vote_set', actorId: user.id, tankId, detail: { weekStart } });
      }
      return { weekStart, weekEnd };
    });
    if (outcome === 'not_found') return notFound(reply);
    if (outcome === 'own') {
      return reply.code(403).send(apiError('own_tank', 'You cannot vote for your own tank.'));
    }
    return voteStateSchema.parse({ ...outcome, myVote: tankId });
  });

  app.delete('/api/gallery/vote', async (req, reply) => {
    const user = await voter(req, reply);
    if (!user) return reply;
    const { weekStart, weekEnd } = await db.transaction(async (tx) => {
      const week = weekNow();
      const removed = await tx
        .delete(schema.tankVotes)
        .where(
          and(
            eq(schema.tankVotes.userId, user.id),
            eq(schema.tankVotes.weekStart, new Date(week.weekStart)),
          ),
        )
        .returning({ tankId: schema.tankVotes.tankId });
      const [gone] = removed;
      if (gone) {
        await audit(tx, {
          action: 'vote_removed',
          actorId: user.id,
          tankId: gone.tankId,
          detail: { weekStart: week.weekStart },
        });
      }
      return week;
    });
    return voteStateSchema.parse({ weekStart, weekEnd, myVote: null });
  });
}
