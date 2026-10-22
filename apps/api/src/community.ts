import { randomInt, randomUUID } from 'node:crypto';
import {
  ateBatchRequestSchema,
  COMMUNITY_HEARTBEAT_MS,
  COMMUNITY_MAX_STREAMS_PER_IP,
  COMMUNITY_MAX_STREAMS_PER_USER,
  COMMUNITY_MAX_STREAMS_TOTAL,
  COMMUNITY_STARTER_STOCK,
  COMMUNITY_STREAM_PATH,
  COMMUNITY_TANK_FEED_CAP,
  COMMUNITY_UPKEEP,
  COMMUNITY_USER_FEED_QUOTA,
  communityFeedRequestSchema,
  communityFeedResponseSchema,
  communityStateSchema,
  communityStreamStateSchema,
  newTankChemistry,
  type CommunityEvent,
  type CommunityQuota,
  type CommunityStreamState,
  type Tank,
} from '@aquarium/shared';
import { applyCare, type LifecycleState } from '@aquarium/sim/lifecycle';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PassThrough } from 'node:stream';
import { schema } from './db/index.ts';
import { apiError, HttpError } from './errors.ts';
import { wireMedicine } from './disease.ts';
import { personalityFromFishId } from './personality.ts';
import type { Limit } from './rate-limit.ts';
import {
  applyAteBatch,
  persistState,
  readTicked,
  render,
  tickLocked,
  type SessionUser,
  type TankRouteDeps,
  type Ticked,
  type Tx,
} from './tanks.ts';
import { frame, CommunityStreams, type StreamCaps } from './communityStream.ts';
import { lockUserRow } from './wallet.ts';

export interface CommunityConfig {
  view: Limit;
  connect: Limit;
  feed: Limit;
  ate: Limit;
  streams: StreamCaps;
  heartbeatMs: number;
  tickMs: number;
  upkeepMs: number;
}

export const DEFAULT_COMMUNITY_CONFIG: CommunityConfig = {
  view: { max: 120, windowMs: 60_000 },
  connect: { max: 30, windowMs: 60_000 },
  feed: { max: 30, windowMs: 10 * 60_000 },
  ate: { max: 30, windowMs: 60_000 },
  streams: {
    perUser: COMMUNITY_MAX_STREAMS_PER_USER,
    perIp: COMMUNITY_MAX_STREAMS_PER_IP,
    total: COMMUNITY_MAX_STREAMS_TOTAL,
    maxQueue: 32,
    stallMs: 30_000,
    closeGraceMs: 2000,
  },
  heartbeatMs: COMMUNITY_HEARTBEAT_MS,
  tickMs: 60_000,
  upkeepMs: 60 * 60_000,
};

const COMMUNITY_TANK_NAME = 'Community Tank';

const SEED_AGE_MS = 7 * 86_400_000;
const EPSILON = 1e-9;
const feedEventPayload = z.object({ portion: z.number() });

interface FeedRow {
  portion: number;
  fedAt: Date;
}

/** Seconds until enough of the oldest feeds leave the window for `portion` to fit under `limit`. */
export function secondsUntilRoom(
  rows: readonly FeedRow[],
  limit: number,
  portion: number,
  windowMs: number,
  nowMs: number,
): number {
  const used = rows.reduce((sum, r) => sum + r.portion, 0);
  let excess = used + portion - limit;
  const ordered = rows.toSorted((a, b) => a.fedAt.getTime() - b.fedAt.getTime());
  for (const row of ordered) {
    excess -= row.portion;
    if (excess <= EPSILON) {
      return Math.max(1, Math.ceil((row.fedAt.getTime() + windowMs - nowMs) / 1000));
    }
  }
  return Math.max(1, Math.ceil(windowMs / 1000));
}

const quotaError = (message: string, wait: number) =>
  new HttpError(429, apiError('quota_exceeded', message), { 'retry-after': String(wait) });

export interface CommunityRouteDeps {
  tank: TankRouteDeps;
  config: CommunityConfig;
}

interface Outcome<T> {
  value: T;
  ticked: Ticked;
  fishRows?: Ticked['fishRows'];
  events?: CommunityEvent[];
  changed?: boolean;
}

export function registerCommunityRoutes({ tank: deps, config }: CommunityRouteDeps): void {
  const { app, database, clock, limiter, species } = deps;
  const streams = new CommunityStreams(config.streams);
  let tankId: string | undefined;

  function stockRows(
    id: string,
    nowMs: number,
    wanted: readonly { species: string; label: string; count: number; first: number }[],
  ) {
    return wanted.flatMap(({ species: speciesId, count, label, first }) => {
      const spec = species.get(speciesId);
      if (!spec) throw new Error(`community tank stock names unknown species "${speciesId}"`);
      return Array.from({ length: count }, (_, i) => {
        const fishId = randomUUID();
        return {
          id: fishId,
          tankId: id,
          species: speciesId,
          name: `${label} ${first + i}`,
          sex: randomInt(2) === 0 ? ('male' as const) : ('female' as const),
          stage: 'adult' as const,
          personality: personalityFromFishId(fishId),
          bornAt: new Date(nowMs - SEED_AGE_MS),
          size: spec.lifecycle.maxSizeM,
        };
      });
    });
  }

  async function ensureTankId(): Promise<string> {
    if (tankId) return tankId;
    tankId = await database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('community-tank'))`);
      const [existing] = await tx.select().from(schema.communityTank);
      if (existing) return existing.tankId;
      const nowMs = clock.now();
      const id = randomUUID();
      await tx.insert(schema.tanks).values({
        id,
        ownerId: null,
        name: COMMUNITY_TANK_NAME,
        biome: 'freshwater',
        size: 'standard',
        chemistry: newTankChemistry('freshwater'),
        lastTickAt: new Date(nowMs),
      });
      await tx.insert(schema.fish).values(
        stockRows(
          id,
          nowMs,
          COMMUNITY_STARTER_STOCK.map((s) => ({ ...s, first: 1 })),
        ),
      );
      await tx.insert(schema.communityTank).values({ id: 1, tankId: id });
      return id;
    });
    return tankId;
  }

  function eventsOf(ticked: Ticked): CommunityEvent[] {
    const { away } = ticked;
    if (!away) return [];
    return [
      ...(away.births ?? []).map((b): CommunityEvent => ({
        type: 'born',
        at: b.bornAt,
        fishId: b.fishId,
        parentId: b.parentId,
        name: b.name,
        species: b.species,
      })),
      ...away.deaths.map((d): CommunityEvent => ({
        type: 'death',
        at: d.diedAt,
        fishId: d.fishId,
        name: d.name,
        species: d.species,
        cause: d.cause,
      })),
    ].toSorted((a, b) => a.at.localeCompare(b.at));
  }

  // Counted from the tank's own events, which carry no user and outlive an account, so deleting
  // an account cannot free the tank-wide cap.
  async function tankFeedRows(tx: Tx, nowMs: number): Promise<FeedRow[]> {
    const rows = await tx
      .select({ payload: schema.events.payload, at: schema.events.at })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.tankId, await ensureTankId()),
          eq(schema.events.kind, 'feed'),
          gt(schema.events.at, new Date(nowMs - COMMUNITY_TANK_FEED_CAP.windowMs)),
        ),
      );
    return rows.map((r) => ({
      portion: feedEventPayload.parse(r.payload).portion,
      fedAt: r.at,
    }));
  }

  async function userFeedRows(tx: Tx, userId: string, nowMs: number): Promise<FeedRow[]> {
    return tx
      .select({ portion: schema.communityFeeds.portion, fedAt: schema.communityFeeds.fedAt })
      .from(schema.communityFeeds)
      .where(
        and(
          eq(schema.communityFeeds.userId, userId),
          gt(schema.communityFeeds.fedAt, new Date(nowMs - COMMUNITY_USER_FEED_QUOTA.windowMs)),
        ),
      );
  }

  function quotaOf(rows: readonly FeedRow[]): CommunityQuota {
    const used = rows.reduce((sum, r) => sum + r.portion, 0);
    const oldest = rows.reduce<Date | null>(
      (min, r) => (min === null || r.fedAt < min ? r.fedAt : min),
      null,
    );
    return {
      limit: COMMUNITY_USER_FEED_QUOTA.portions,
      used,
      remaining: Math.max(0, COMMUNITY_USER_FEED_QUOTA.portions - used),
      windowMs: COMMUNITY_USER_FEED_QUOTA.windowMs,
      resetsAt: oldest
        ? new Date(oldest.getTime() + COMMUNITY_USER_FEED_QUOTA.windowMs).toISOString()
        : null,
    };
  }

  async function streamState(
    tx: Tx,
    ticked: Ticked,
    fishRows: Ticked['fishRows'] | undefined,
    nowMs: number,
  ): Promise<CommunityStreamState> {
    const tank: Tank = await render(tx, ticked, fishRows);
    const fed = (await tankFeedRows(tx, nowMs)).reduce((sum, r) => sum + r.portion, 0);
    return communityStreamStateSchema.parse({
      tank,
      viewers: streams.size,
      tankFeedRemaining: Math.max(0, COMMUNITY_TANK_FEED_CAP.portions - fed),
      at: new Date(nowMs).toISOString(),
    });
  }

  async function transact<T>(
    fn: (tx: Tx, ticked: Ticked, nowMs: number) => Promise<Outcome<T>>,
  ): Promise<{ value: T; state: CommunityStreamState }> {
    const id = await ensureTankId();
    const done = await database.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.tanks)
        .where(eq(schema.tanks.id, id))
        .for('update');
      if (!row) throw new Error('the community tank row is missing');
      const ticked = await tickLocked(tx, deps, row, null);
      const nowMs = ticked.nowMs;
      const outcome = await fn(tx, ticked, nowMs);
      const state = await streamState(tx, outcome.ticked, outcome.fishRows, nowMs);
      return { outcome, state, ticked };
    });
    const events = [...eventsOf(done.ticked), ...(done.outcome.events ?? [])];
    if (events.length > 0 || done.outcome.changed || done.ticked.away) {
      for (const event of events) streams.broadcast(event.type, event);
      streams.broadcast('state', done.state);
    }
    return { value: done.outcome.value, state: done.state };
  }

  // Viewers and replays read without the row lock unless a catch-up step is due, so they cannot
  // queue every feeder behind them.
  async function readState(): Promise<CommunityStreamState> {
    const id = await ensureTankId();
    const resting = await database.db.transaction(
      async (tx) => {
        const [row] = await tx.select().from(schema.tanks).where(eq(schema.tanks.id, id));
        if (!row) throw new Error('the community tank row is missing');
        const ticked = await readTicked(tx, deps, row);
        return ticked ? streamState(tx, ticked, undefined, ticked.nowMs) : null;
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    if (resting) return resting;
    return (await transact(async (_tx, ticked) => ({ value: null, ticked }))).state;
  }

  function safeForStarterStock(state: LifecycleState): boolean {
    return COMMUNITY_STARTER_STOCK.every((stock) => {
      const spec = species.get(stock.species);
      if (!spec)
        throw new Error(`community starter species "${stock.species}" is not in the catalog`);
      return (
        state.water.ammonia <= spec.lifecycle.ammoniaTolerance &&
        state.chemistry.nitrite <= spec.chemistry.nitriteTolerance
      );
    });
  }

  async function keepTank(): Promise<void> {
    await transact(async (tx, ticked, nowMs) => {
      let { tank } = ticked;
      let state = ticked.state;
      let fishRows = ticked.fishRows;
      let changed = false;

      const [lastChange] = await tx
        .select({ at: schema.events.at })
        .from(schema.events)
        .where(and(eq(schema.events.tankId, tank.id), eq(schema.events.kind, 'water_change')))
        .orderBy(desc(schema.events.at))
        .limit(1);
      const lastChangeMs = (lastChange?.at ?? tank.createdAt).getTime();
      const changeWater = async () => {
        const applied = applyCare(
          state,
          { type: 'water_change' },
          tank.biome,
          deps.chemistryParams,
          nowMs,
        );
        if (!applied.ok) throw new Error(`community water change was refused: ${applied.reason}`);
        state = applied.value;
        fishRows = await persistState(tx, tank, fishRows, state);
        await tx
          .insert(schema.events)
          .values({ tankId: tank.id, at: new Date(nowMs), kind: 'water_change', payload: {} });
        tank = {
          ...tank,
          water: state.water,
          chemistry: state.chemistry,
          medicine: wireMedicine(state.medicine),
        };
        changed = true;
      };
      if (nowMs - lastChangeMs >= COMMUNITY_UPKEEP.waterChangeEveryMs) await changeWater();

      const cleared = fishRows.filter(
        (f) =>
          f.status === 'dead' &&
          f.diedAt !== null &&
          nowMs - f.diedAt.getTime() >= COMMUNITY_UPKEEP.deadFishKeepMs,
      );
      if (cleared.length > 0) {
        await tx.insert(schema.memorials).values(
          cleared.flatMap((f) =>
            f.diedAt && f.cause
              ? [
                  {
                    tankId: tank.id,
                    fishName: f.name,
                    species: f.species,
                    bornAt: f.bornAt,
                    diedAt: f.diedAt,
                    cause: f.cause,
                  },
                ]
              : [],
          ),
        );
        await tx.delete(schema.fish).where(
          inArray(
            schema.fish.id,
            cleared.map((f) => f.id),
          ),
        );
        const gone = new Set(cleared.map((f) => f.id));
        fishRows = fishRows.filter((f) => !gone.has(f.id));
        changed = true;
      }

      const alive = fishRows.filter((f) => f.status === 'alive');
      if (alive.length < COMMUNITY_UPKEEP.restockBelowAlive) {
        if (!safeForStarterStock(state)) await changeWater();
      }
      if (alive.length < COMMUNITY_UPKEEP.restockBelowAlive && safeForStarterStock(state)) {
        const wanted = COMMUNITY_STARTER_STOCK.map((stock) => ({
          ...stock,
          count: stock.count - alive.filter((f) => f.species === stock.species).length,
          first:
            Math.max(
              0,
              ...fishRows
                .filter((f) => f.species === stock.species)
                .map((f) => Number(f.name.slice(stock.label.length + 1)) || 0),
            ) + 1,
        })).filter((stock) => stock.count > 0);
        const added = wanted.length
          ? await tx
              .insert(schema.fish)
              .values(stockRows(tank.id, nowMs, wanted))
              .returning()
          : [];
        fishRows = [...fishRows, ...added];
        changed ||= added.length > 0;
      }

      return { value: null, ticked: { ...ticked, tank }, fishRows, changed };
    });
  }

  async function quotaFor(user: SessionUser | null): Promise<CommunityQuota | null> {
    if (!user?.emailVerified) return null;
    return database.db.transaction(async (tx) =>
      quotaOf(await userFeedRows(tx, user.id, clock.now())),
    );
  }

  const throttled = (reply: FastifyReply, wait: number) =>
    reply
      .code(429)
      .header('retry-after', String(wait))
      .send(apiError('rate_limited', `Too many requests. Try again in ${wait} s.`));

  const guarded =
    <T>(handler: (req: FastifyRequest, reply: FastifyReply) => Promise<T>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(req, reply);
      } catch (err) {
        if (err instanceof HttpError)
          return reply.code(err.status).headers(err.headers).send(err.body);
        throw err;
      }
    };

  async function verifiedUser(req: FastifyRequest): Promise<SessionUser> {
    const user = await deps.currentUser(req);
    if (!user) throw new HttpError(401, apiError('unauthenticated', 'Sign in to feed the fish.'));
    if (!user.emailVerified) {
      throw new HttpError(
        403,
        apiError('email_not_verified', 'Verify your email address before feeding the fish.'),
      );
    }
    return user;
  }

  function userThrottle(bucket: 'feed' | 'ate', userId: string): void {
    const wait = limiter.consume(`community-${bucket}:${userId}`, config[bucket]);
    if (wait > 0) {
      throw new HttpError(
        429,
        apiError('rate_limited', `Too many requests. Try again in ${wait} s.`),
        { 'retry-after': String(wait) },
      );
    }
  }

  app.get(
    '/api/community',
    guarded(async (req, reply) => {
      const wait = limiter.consume(`community-view:${req.ip}`, config.view);
      if (wait > 0) return throttled(reply, wait);
      const user = await deps.currentUser(req);
      const state = await readState();
      return communityStateSchema.parse({ ...state, quota: await quotaFor(user) });
    }),
  );

  app.post(
    '/api/community/feed',
    guarded(async (req, reply) => {
      const user = await verifiedUser(req);
      const body = communityFeedRequestSchema.parse(req.body);
      const key = body.idempotencyKey;

      const findFeed = async (tx: Pick<Tx, 'select'>) => {
        const [row] = await tx
          .select()
          .from(schema.communityFeeds)
          .where(
            and(
              eq(schema.communityFeeds.userId, user.id),
              eq(schema.communityFeeds.idempotencyKey, key),
            ),
          );
        return row;
      };
      const sameFeed = (row: NonNullable<Awaited<ReturnType<typeof findFeed>>>) => {
        if (row.food !== body.food || Math.abs(row.portion - body.portion) > EPSILON) {
          throw new HttpError(
            409,
            apiError(
              'conflict',
              'That idempotency key was used for a different feed.',
              undefined,
              'key_reused',
            ),
          );
        }
      };
      const replayResponse = async () => {
        const state = await readState();
        return reply.code(200).send(
          communityFeedResponseSchema.parse({
            state: { ...state, quota: await quotaFor(user) },
            replayed: true,
          }),
        );
      };

      const seen = await findFeed(database.db);
      if (seen) {
        sameFeed(seen);
        return replayResponse();
      }
      userThrottle('feed', user.id);

      const outcome = await transact(async (tx, ticked, nowMs) => {
        await lockUserRow(tx, user.id);
        const again = await findFeed(tx);
        if (again) {
          sameFeed(again);
          return { value: 'replayed' as const, ticked };
        }
        const mine = await userFeedRows(tx, user.id, nowMs);
        const used = mine.reduce((sum, r) => sum + r.portion, 0);
        if (used + body.portion > COMMUNITY_USER_FEED_QUOTA.portions + EPSILON) {
          throw quotaError(
            'You have fed your share for now. Come back later.',
            secondsUntilRoom(
              mine,
              COMMUNITY_USER_FEED_QUOTA.portions,
              body.portion,
              COMMUNITY_USER_FEED_QUOTA.windowMs,
              nowMs,
            ),
          );
        }
        const everyone = await tankFeedRows(tx, nowMs);
        const fedTogether = everyone.reduce((sum, r) => sum + r.portion, 0);
        if (fedTogether + body.portion > COMMUNITY_TANK_FEED_CAP.portions + EPSILON) {
          throw quotaError(
            'The fish have been fed enough for now. Try again later.',
            secondsUntilRoom(
              everyone,
              COMMUNITY_TANK_FEED_CAP.portions,
              body.portion,
              COMMUNITY_TANK_FEED_CAP.windowMs,
              nowMs,
            ),
          );
        }
        const applied = applyCare(
          ticked.state,
          { type: 'feed', food: body.food, portion: body.portion },
          ticked.tank.biome,
          deps.chemistryParams,
          nowMs,
        );
        if (!applied.ok) throw new HttpError(422, apiError('feeding_rejected', applied.reason));
        const fishRows = await persistState(tx, ticked.tank, ticked.fishRows, applied.value);
        await tx.insert(schema.events).values({
          tankId: ticked.tank.id,
          at: new Date(nowMs),
          kind: 'feed',
          payload: { food: body.food, portion: body.portion },
        });
        await tx.insert(schema.communityFeeds).values({
          userId: user.id,
          idempotencyKey: key,
          food: body.food,
          portion: body.portion,
          fedAt: new Date(nowMs),
        });
        const [owner] = await tx
          .select({ handle: schema.user.handle })
          .from(schema.user)
          .where(eq(schema.user.id, user.id));
        return {
          value: 'fed' as const,
          ticked: {
            ...ticked,
            tank: {
              ...ticked.tank,
              water: applied.value.water,
              chemistry: applied.value.chemistry,
              medicine: wireMedicine(applied.value.medicine),
            },
          },
          fishRows,
          events: [
            {
              type: 'feed' as const,
              at: new Date(nowMs).toISOString(),
              food: body.food,
              portion: body.portion,
              by: owner?.handle ?? null,
            },
          ],
        };
      });
      return reply.code(outcome.value === 'fed' ? 201 : 200).send(
        communityFeedResponseSchema.parse({
          state: { ...outcome.state, quota: await quotaFor(user) },
          replayed: outcome.value === 'replayed',
        }),
      );
    }),
  );

  app.post(
    '/api/community/ate',
    guarded(async (req) => {
      const user = await verifiedUser(req);
      const body = ateBatchRequestSchema.parse(req.body);
      userThrottle('ate', user.id);
      const { state } = await transact(async (tx, ticked, nowMs) => {
        const result = await applyAteBatch(tx, ticked, body, nowMs);
        if (result.replayed) {
          req.log.debug({ batchId: body.batchId }, 'community ate batch replay ignored');
          return { value: null, ticked };
        }
        return {
          value: null,
          ticked: { ...ticked, tank: result.tank },
          fishRows: result.fishRows,
          changed: true,
        };
      });
      return communityStateSchema.parse({ ...state, quota: await quotaFor(user) });
    }),
  );

  app.get(
    COMMUNITY_STREAM_PATH,
    guarded(async (req, reply) => {
      const wait = limiter.consume(`community-connect:${req.ip}`, config.connect);
      if (wait > 0) return throttled(reply, wait);
      const user = await deps.currentUser(req);
      const stream = new PassThrough({ highWaterMark: 64 * 1024 });
      const client = streams.open(user?.id ?? null, req.ip, stream);
      if (typeof client === 'string') {
        stream.destroy();
        if (client === 'total') {
          return reply
            .code(503)
            .header('retry-after', '30')
            .send(apiError('rate_limited', 'The tank has too many viewers right now.'));
        }
        return reply
          .code(429)
          .header('retry-after', '10')
          .send(
            apiError(
              'rate_limited',
              client === 'user'
                ? 'You already have the community tank open in too many places.'
                : 'Too many viewers from this network.',
            ),
          );
      }
      req.raw.once('close', () => stream.destroy());
      stream.once('close', () => {
        if (!reply.raw.writableEnded) reply.raw.destroy();
      });
      let first: string;
      try {
        const state = await readState();
        first = frame('state', state);
      } catch (err) {
        stream.destroy();
        throw err;
      }
      if (client.closed) return reply;
      streams.start(client, first);
      return reply
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-store, no-transform')
        .header('x-accel-buffering', 'no')
        .header('connection', 'close')
        .header('x-robots-tag', 'noindex, nofollow')
        .send(stream);
    }),
  );

  let ticking = false;
  let upkeepRun: Promise<void> | null = null;
  const timers: NodeJS.Timeout[] = [];

  function runUpkeep(): void {
    if (upkeepRun) return;
    upkeepRun = keepTank()
      .catch((err: unknown) => app.log.error({ err }, 'community upkeep failed'))
      .finally(() => {
        upkeepRun = null;
      });
  }

  async function tickWhileWatched(): Promise<void> {
    if (ticking || streams.size === 0) return;
    ticking = true;
    try {
      await transact(async (_tx, ticked) => ({ value: null, ticked }));
    } catch (err) {
      app.log.error({ err }, 'community tick failed');
    } finally {
      ticking = false;
    }
  }

  app.addHook('onReady', async () => {
    const heartbeat = setInterval(() => {
      streams.sweep();
      if (streams.size > 0) streams.broadcast('viewers', { viewers: streams.size });
    }, config.heartbeatMs);
    const ticker = setInterval(() => void tickWhileWatched(), config.tickMs);
    const upkeep = setInterval(runUpkeep, config.upkeepMs);
    upkeep.unref();
    timers.push(upkeep);
    heartbeat.unref();
    ticker.unref();
    timers.push(heartbeat, ticker);
    runUpkeep();
  });

  app.addHook('preClose', async () => {
    for (const timer of timers) clearInterval(timer);
    streams.closeAll();
    await upkeepRun;
  });
}
