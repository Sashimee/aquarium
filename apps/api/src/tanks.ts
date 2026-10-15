import {
  addFishRequestSchema,
  ateBatchRequestSchema,
  careActionSchema,
  createTankRequestSchema,
  decorLayoutSchema,
  findDecorProblems,
  idSchema,
  legacyTintSeed,
  speciesListSchema,
  tankListSchema,
  tankSchema,
  updateTankRequestSchema,
  waterSchema,
  type AwaySummary,
  type CareAction,
  type Tank,
} from '@aquarium/shared';
import {
  applyCare,
  applyEating,
  catchUp,
  DEFAULT_WATER_PARAMETERS,
  FEEDING_WINDOW_MINUTES,
  GRACE_PERIOD_MS,
  hasCapacityFor,
  MAX_FISH_PER_TANK,
  TANK_BIOLOAD_CAPACITY,
  VACATION_FEEDER_ASSET_ID,
  type LifecycleFish,
  type LifecycleState,
} from '@aquarium/sim/lifecycle';
import { randomInt } from 'node:crypto';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from './clock.ts';
import { schema, type Database } from './db/index.ts';
import { apiError } from './errors.ts';
import type { Limit, RateLimiter } from './rate-limit.ts';
import type { SpeciesCatalog } from './species.ts';

export interface CareLimits {
  feed: Limit;
  care: Limit;
  ate: Limit;
  addFish: Limit;
}

export const DEFAULT_CARE_LIMITS: CareLimits = {
  feed: { max: 20, windowMs: 10 * 60_000 },
  care: { max: 60, windowMs: 10 * 60_000 },
  ate: { max: 30, windowMs: 60_000 },
  addFish: { max: 20, windowMs: 60 * 60_000 },
};

export const MAX_TANKS_PER_USER = 5;
const EVENT_RETENTION_MS = 90 * 86_400_000;

export interface SessionUser {
  id: string;
  emailVerified: boolean;
  createdAt: Date;
}

export interface TankRouteDeps {
  app: FastifyInstance;
  database: Database;
  species: SpeciesCatalog;
  clock: Clock;
  limiter: RateLimiter;
  limits: CareLimits;
  currentUser: (req: FastifyRequest) => Promise<SessionUser | null>;
}

type Tx = Parameters<Parameters<Database['db']['transaction']>[0]>[0];
type TankRow = typeof schema.tanks.$inferSelect;
type FishRow = typeof schema.fish.$inferSelect;

const feedPayloadSchema = z.looseObject({ portion: z.number().positive() });
const atePayloadSchema = z.looseObject({ fishId: idSchema, portion: z.number().positive() });

const tankParamsSchema = z.strictObject({ tankId: idSchema });
const fishParamsSchema = z.strictObject({ tankId: idSchema, fishId: idSchema });

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ReturnType<typeof apiError>,
  ) {
    super(body.error.message);
  }
}

const notFound = () => new HttpError(404, apiError('not_found', 'Tank not found.'));

function toLifecycleFish(row: FishRow): LifecycleFish {
  return {
    id: row.id,
    species: row.species,
    bornAtMs: row.bornAt.getTime(),
    size: row.size,
    hunger: row.hunger,
    health: row.health,
    alive: row.status === 'alive',
    diedAtMs: row.diedAt?.getTime() ?? null,
    cause: row.cause,
  };
}

function storedLayout(row: TankRow) {
  return row.decorLayout === null ? [] : decorLayoutSchema.parse(row.decorLayout);
}

function hasVacationFeeder(row: TankRow): boolean {
  return storedLayout(row).some((item) => item.assetId === VACATION_FEEDER_ASSET_ID);
}

interface Ticked {
  tank: TankRow;
  fishRows: FishRow[];
  state: LifecycleState;
  away: AwaySummary | null;
}

async function lockAndTick(
  tx: Tx,
  deps: TankRouteDeps,
  tankId: string,
  user: SessionUser,
): Promise<Ticked> {
  const now = deps.clock.now();
  const [tank] = await tx
    .select()
    .from(schema.tanks)
    .where(and(eq(schema.tanks.id, tankId), eq(schema.tanks.ownerId, user.id)))
    .for('update');
  if (!tank) throw notFound();

  const fishRows = await tx.select().from(schema.fish).where(eq(schema.fish.tankId, tank.id));
  const initial: LifecycleState = {
    water: waterSchema.parse(tank.water),
    fish: fishRows.map(toLifecycleFish),
  };
  const result = catchUp({
    state: initial,
    fromMs: tank.lastTickAt.getTime(),
    toMs: now,
    species: new Map([...deps.species].map(([id, s]) => [id, s.lifecycle])),
    params: DEFAULT_WATER_PARAMETERS,
    graceEndsAtMs: user.createdAt.getTime() + GRACE_PERIOD_MS,
    vacationFeeder: hasVacationFeeder(tank),
  });

  await tx
    .delete(schema.events)
    .where(
      and(
        eq(schema.events.tankId, tank.id),
        lt(schema.events.at, new Date(now - EVENT_RETENTION_MS)),
      ),
    );

  const byId = new Map(fishRows.map((r) => [r.id, r]));
  const away: AwaySummary = {
    elapsedMinutes: result.elapsedMinutes,
    capped: result.capped,
    deaths: result.deaths.map((d) => {
      const row = byId.get(d.fishId);
      if (!row) throw new Error('lifecycle returned a death for an unknown fish');
      return {
        fishId: d.fishId,
        name: row.name,
        species: row.species,
        cause: d.cause,
        diedAt: new Date(d.diedAtMs).toISOString(),
      };
    }),
  };

  if (result.steps === 0) return { tank, fishRows, state: initial, away: null };

  const updatedRows = await persistFish(tx, fishRows, result.state);
  const advancedTo = new Date(result.advancedToMs);
  await tx
    .update(schema.tanks)
    .set({ water: result.state.water, lastTickAt: advancedTo, updatedAt: new Date(now) })
    .where(eq(schema.tanks.id, tank.id));
  const recentDeaths = result.deaths.filter((d) => d.diedAtMs >= now - EVENT_RETENTION_MS);
  if (recentDeaths.length > 0) {
    await tx.insert(schema.events).values(
      recentDeaths.map((d) => ({
        tankId: tank.id,
        at: new Date(d.diedAtMs),
        kind: 'death' as const,
        payload: { fishId: d.fishId, cause: d.cause },
      })),
    );
  }
  return {
    tank: { ...tank, water: result.state.water, lastTickAt: advancedTo },
    fishRows: updatedRows,
    state: result.state,
    away,
  };
}

async function persistFish(
  tx: Tx,
  before: readonly FishRow[],
  state: LifecycleState,
): Promise<FishRow[]> {
  const next = new Map(state.fish.map((f) => [f.id, f]));
  const out: FishRow[] = [];
  for (const row of before) {
    const f = next.get(row.id);
    if (!f) throw new Error('lifecycle dropped a fish');
    const changed = {
      hunger: f.hunger,
      health: f.health,
      size: f.size,
      status: f.alive ? ('alive' as const) : ('dead' as const),
      diedAt: f.diedAtMs === null ? null : new Date(f.diedAtMs),
      cause: f.cause,
    };
    const dirty =
      changed.hunger !== row.hunger ||
      changed.health !== row.health ||
      changed.size !== row.size ||
      changed.status !== row.status;
    if (dirty) await tx.update(schema.fish).set(changed).where(eq(schema.fish.id, row.id));
    out.push(dirty ? { ...row, ...changed } : row);
  }
  return out;
}

async function persistState(tx: Tx, tank: TankRow, fishRows: FishRow[], state: LifecycleState) {
  await tx.update(schema.tanks).set({ water: state.water }).where(eq(schema.tanks.id, tank.id));
  return persistFish(tx, fishRows, state);
}

async function render(tx: Tx, ticked: Ticked, fishRows = ticked.fishRows): Promise<Tank> {
  const { tank, away } = ticked;
  const memorials = await tx
    .select()
    .from(schema.memorials)
    .where(eq(schema.memorials.tankId, tank.id))
    .orderBy(desc(schema.memorials.diedAt));
  return tankSchema.parse({
    id: tank.id,
    name: tank.name,
    biome: tank.biome,
    decorLayout: storedLayout(tank).map((item) => ({
      ...item,
      tintSeed: item.tintSeed ?? legacyTintSeed(item),
    })),
    decorEdited: tank.decorLayout !== null,
    water: tank.water,
    lastTickAt: tank.lastTickAt.toISOString(),
    fish: fishRows
      .toSorted((a, b) => a.bornAt.getTime() - b.bornAt.getTime() || a.id.localeCompare(b.id))
      .map((f) => ({
        id: f.id,
        tankId: f.tankId,
        species: f.species,
        name: f.name,
        sex: f.sex,
        bornAt: f.bornAt.toISOString(),
        size: f.size,
        hunger: f.hunger,
        health: f.health,
        status: f.status,
        diedAt: f.diedAt?.toISOString() ?? null,
        cause: f.cause,
      })),
    memorials: memorials.map((m) => ({
      id: m.id,
      tankId: m.tankId,
      fishName: m.fishName,
      species: m.species,
      bornAt: m.bornAt.toISOString(),
      diedAt: m.diedAt.toISOString(),
      cause: m.cause,
    })),
    ...(away ? { away } : {}),
  });
}

export function registerTankRoutes(deps: TankRouteDeps): void {
  const { app, database, species, clock, limiter, limits } = deps;

  async function authorize(req: FastifyRequest, requireVerified = true): Promise<SessionUser> {
    const user = await deps.currentUser(req);
    if (!user) throw new HttpError(401, apiError('unauthenticated', 'Sign in required.'));
    if (requireVerified && !user.emailVerified) {
      throw new HttpError(
        403,
        apiError('email_not_verified', 'Verify your email address before using your tank.'),
      );
    }
    return user;
  }

  function throttle(userId: string, bucket: keyof CareLimits): void {
    const wait = limiter.consume(`${bucket}:${userId}`, limits[bucket]);
    if (wait > 0) {
      throw new HttpError(
        429,
        apiError('rate_limited', `Too many requests. Try again in ${wait} s.`),
      );
    }
  }

  const guarded =
    <T>(handler: (req: FastifyRequest, reply: FastifyReply) => Promise<T>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(req, reply);
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.status).send(err.body);
        throw err;
      }
    };

  async function withTank<T>(
    user: SessionUser,
    tankId: string,
    fn: (tx: Tx, ticked: Ticked) => Promise<T>,
  ): Promise<T> {
    return database.db.transaction(async (tx) => fn(tx, await lockAndTick(tx, deps, tankId, user)));
  }

  app.get(
    '/api/species',
    guarded(async (req) => {
      await authorize(req, false);
      return speciesListSchema.parse([...species.values()]);
    }),
  );

  app.get(
    '/api/tanks',
    guarded(async (req) => {
      const user = await authorize(req);
      const owned = await database.db
        .select({ id: schema.tanks.id })
        .from(schema.tanks)
        .where(eq(schema.tanks.ownerId, user.id))
        .orderBy(schema.tanks.createdAt);
      const tanks: Tank[] = [];
      for (const { id } of owned) {
        tanks.push(await withTank(user, id, (tx, ticked) => render(tx, ticked)));
      }
      return tankListSchema.parse(tanks);
    }),
  );

  app.post(
    '/api/tanks',
    guarded(async (req, reply) => {
      const user = await authorize(req);
      const body = createTankRequestSchema.parse(req.body);
      const created = await database.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tanks:${user.id}`}))`);
        const [{ count } = { count: 0 }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.tanks)
          .where(eq(schema.tanks.ownerId, user.id));
        if (count >= MAX_TANKS_PER_USER) {
          throw new HttpError(
            409,
            apiError('conflict', `You can have at most ${MAX_TANKS_PER_USER} tanks.`),
          );
        }
        const [row] = await tx
          .insert(schema.tanks)
          .values({
            ownerId: user.id,
            name: body.name,
            biome: body.biome,
            lastTickAt: new Date(clock.now()),
          })
          .returning();
        if (!row) throw new Error('tank insert returned no row');
        return render(tx, {
          tank: row,
          fishRows: [],
          state: { water: waterSchema.parse(row.water), fish: [] },
          away: null,
        });
      });
      return reply.code(201).send(created);
    }),
  );

  app.get(
    '/api/tanks/:tankId',
    guarded(async (req) => {
      const user = await authorize(req);
      const { tankId } = tankParamsSchema.parse(req.params);
      return withTank(user, tankId, (tx, ticked) => render(tx, ticked));
    }),
  );

  app.patch(
    '/api/tanks/:tankId',
    guarded(async (req) => {
      const user = await authorize(req);
      const { tankId } = tankParamsSchema.parse(req.params);
      const body = updateTankRequestSchema.parse(req.body);
      throttle(user.id, 'care');
      return withTank(user, tankId, async (tx, ticked) => {
        if (body.decorLayout !== undefined) {
          const problems = findDecorProblems(
            ticked.tank.biome,
            body.decorLayout,
            VACATION_FEEDER_ASSET_ID,
          );
          if (problems.length > 0) {
            throw new HttpError(
              400,
              apiError(
                'validation_failed',
                'The decor layout has pieces this tank cannot hold. Remove or move them and save again.',
                problems.map((p) => ({
                  path: ['decorLayout', p.index, p.field],
                  message: p.message,
                })),
              ),
            );
          }
        }
        const [row] = await tx
          .update(schema.tanks)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.decorLayout !== undefined
              ? {
                  decorLayout: body.decorLayout.map((item) => ({
                    ...item,
                    tintSeed: item.tintSeed ?? legacyTintSeed(item),
                  })),
                }
              : {}),
            updatedAt: new Date(clock.now()),
          })
          .where(eq(schema.tanks.id, tankId))
          .returning();
        return render(tx, { ...ticked, tank: row ?? ticked.tank });
      });
    }),
  );

  app.post(
    '/api/tanks/:tankId/fish',
    guarded(async (req, reply) => {
      const user = await authorize(req);
      const { tankId } = tankParamsSchema.parse(req.params);
      const body = addFishRequestSchema.parse(req.body);
      const spec = species.get(body.species);
      if (!spec) {
        return reply
          .code(400)
          .send(apiError('validation_failed', `Unknown species "${body.species}".`));
      }
      throttle(user.id, 'addFish');
      const result = await withTank(user, tankId, async (tx, ticked) => {
        if (spec.biome !== ticked.tank.biome) {
          throw new HttpError(
            400,
            apiError('validation_failed', `${spec.commonName} needs a ${spec.biome} tank.`),
          );
        }
        const existing = ticked.fishRows.map((f) => ({
          alive: f.status === 'alive',
          maxBioload: species.get(f.species)?.lifecycle.bioload ?? 0,
        }));
        if (
          !hasCapacityFor(
            existing,
            spec.lifecycle.bioload,
            TANK_BIOLOAD_CAPACITY,
            MAX_FISH_PER_TANK,
          )
        ) {
          throw new HttpError(
            409,
            apiError(
              'conflict',
              'This tank is at capacity. Net a dead fish or start another tank.',
            ),
          );
        }
        const [row] = await tx
          .insert(schema.fish)
          .values({
            tankId,
            species: spec.id,
            name: body.name,
            sex: randomInt(2) === 0 ? 'male' : 'female',
            bornAt: new Date(clock.now()),
            size: spec.lifecycle.birthSizeM,
          })
          .returning();
        if (!row) throw new Error('fish insert returned no row');
        return { tank: await render(tx, { ...ticked, fishRows: [...ticked.fishRows, row] }) };
      });
      return reply.code(201).send(result.tank);
    }),
  );

  app.delete(
    '/api/tanks/:tankId/fish/:fishId',
    guarded(async (req) => {
      const user = await authorize(req);
      const { tankId, fishId } = fishParamsSchema.parse(req.params);
      const result = await withTank(user, tankId, async (tx, ticked) => {
        const row = ticked.fishRows.find((f) => f.id === fishId);
        if (!row) throw new HttpError(404, apiError('not_found', 'Fish not found.'));
        if (row.status !== 'dead' || !row.diedAt || !row.cause) {
          throw new HttpError(409, apiError('conflict', 'Only a dead fish can be netted.'));
        }
        await tx.insert(schema.memorials).values({
          tankId,
          fishName: row.name,
          species: row.species,
          bornAt: row.bornAt,
          diedAt: row.diedAt,
          cause: row.cause,
        });
        await tx.delete(schema.fish).where(eq(schema.fish.id, fishId));
        const fishRows = ticked.fishRows.filter((f) => f.id !== fishId);
        return { tank: await render(tx, ticked, fishRows) };
      });
      return result.tank;
    }),
  );

  app.post(
    '/api/tanks/:tankId/care',
    guarded(async (req) => {
      const user = await authorize(req);
      const { tankId } = tankParamsSchema.parse(req.params);
      const action: CareAction = careActionSchema.parse(req.body);
      throttle(user.id, action.type === 'feed' ? 'feed' : 'care');
      const result = await withTank(user, tankId, async (tx, ticked) => {
        const applied = applyCare(ticked.state, action, ticked.tank.biome);
        if (!applied.ok) {
          throw new HttpError(422, apiError('feeding_rejected', applied.reason));
        }
        const fishRows = await persistState(tx, ticked.tank, ticked.fishRows, applied.value);
        const at = new Date(clock.now());
        await tx.insert(schema.events).values({
          tankId,
          at,
          kind: action.type,
          payload: action.type === 'feed' ? { food: action.food, portion: action.portion } : {},
        });
        const tank = { ...ticked.tank, water: applied.value.water };
        return { tank: await render(tx, { ...ticked, tank }, fishRows) };
      });
      return result.tank;
    }),
  );

  app.post(
    '/api/tanks/:tankId/ate',
    guarded(async (req) => {
      const user = await authorize(req);
      const { tankId } = tankParamsSchema.parse(req.params);
      const body = ateBatchRequestSchema.parse(req.body);
      throttle(user.id, 'ate');
      const result = await withTank(user, tankId, async (tx, ticked) => {
        if (body.batchId) {
          const claimed = await tx
            .insert(schema.ateBatches)
            .values({ tankId, batchId: body.batchId })
            .onConflictDoNothing()
            .returning({ batchId: schema.ateBatches.batchId });
          if (claimed.length === 0) {
            // The replay's payload isn't compared with the original, so a client reusing an id would
            // drop reports silently; this log is the only trace.
            req.log.debug({ tankId, batchId: body.batchId }, 'ate batch replay ignored');
            return { tank: await render(tx, ticked) };
          }
        }
        const nowMs = clock.now();
        const windowMs = FEEDING_WINDOW_MINUTES * 60_000;
        const recent = await tx
          .select({ kind: schema.events.kind, payload: schema.events.payload })
          .from(schema.events)
          .where(
            and(
              eq(schema.events.tankId, tankId),
              inArray(schema.events.kind, ['feed', 'ate']),
              gte(schema.events.at, new Date(nowMs - windowMs)),
            ),
          );
        let fedInWindow = 0;
        let eatenInWindow = 0;
        const eatenByFishInWindow = new Map<string, number>();
        for (const e of recent) {
          if (e.kind === 'feed') {
            fedInWindow += feedPayloadSchema.parse(e.payload).portion;
          } else {
            const { fishId, portion } = atePayloadSchema.parse(e.payload);
            eatenInWindow += portion;
            eatenByFishInWindow.set(fishId, (eatenByFishInWindow.get(fishId) ?? 0) + portion);
          }
        }
        const reports = body.reports.map((r) => ({
          fishId: r.fishId,
          portion: r.portion,
          atMs: Date.parse(r.at),
        }));
        const applied = applyEating(ticked.state, reports, {
          nowMs,
          windowMs,
          fedInWindow,
          eatenInWindow,
          eatenByFishInWindow,
        });
        if (!applied.ok) {
          throw new HttpError(422, apiError('feeding_rejected', applied.reason));
        }
        const fishRows = await persistState(tx, ticked.tank, ticked.fishRows, applied.value);
        const perFish = new Map<string, number>();
        for (const r of reports) perFish.set(r.fishId, (perFish.get(r.fishId) ?? 0) + r.portion);
        await tx.insert(schema.events).values(
          [...perFish].map(([fishId, portion]) => ({
            tankId,
            at: new Date(nowMs),
            kind: 'ate' as const,
            payload: { fishId, portion },
          })),
        );
        const tank = { ...ticked.tank, water: applied.value.water };
        return { tank: await render(tx, { ...ticked, tank }, fishRows) };
      });
      return result.tank;
    }),
  );
}
