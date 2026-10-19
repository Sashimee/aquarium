import {
  addFishRequestSchema,
  ateBatchRequestSchema,
  backgroundIdSchema,
  careActionSchema,
  chemistrySchema,
  containsBlockedWord,
  createTankRequestSchema,
  DEFAULT_BACKGROUND_ID,
  decorLayoutSchema,
  diseaseStateSchema,
  equipmentSchema,
  findDecorProblems,
  idSchema,
  isBackgroundForBiome,
  isPlayableBiome,
  legacyTintSeed,
  MAX_DISPLAY_TANKS,
  MAX_QUARANTINE_TANKS,
  newTankChemistry,
  TANK_SIZES,
  personalitySchema,
  speciesListSchema,
  tankListSchema,
  tankSchema,
  updateTankRequestSchema,
  waterSchema,
  type AwaySummary,
  type CareAction,
  type ChemistryParameters,
  type Tank,
} from '@aquarium/shared';
import {
  applyCare,
  applyEating,
  BIOLOAD_CAPACITY_BY_SIZE,
  BREEDING_SHELTER_ASSET_IDS,
  catchUp,
  DEFAULT_WATER_PARAMETERS,
  FEEDING_WINDOW_MINUTES,
  GRACE_PERIOD_MS,
  hasCapacityFor,
  VACATION_FEEDER_ASSET_ID,
  type BirthRecord,
  type LifecycleFish,
  type LifecycleState,
} from '@aquarium/sim/lifecycle';
import { randomInt, randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from './audit.ts';
import { personalityFromFishId } from './personality.ts';
import { issueShareToken } from './shareToken.ts';
import type { Clock } from './clock.ts';
import { schema, type Database } from './db/index.ts';
import { recordCollection, type CollectionObservation } from './collection.ts';
import { countRecentVisitDays, recordVisit } from './visits.ts';
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
  chemistryParams: ChemistryParameters;
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

const nameNotPublic = () =>
  new HttpError(
    400,
    apiError(
      'validation_failed',
      'A shared tank is shown by name, and this name is not allowed. Pick another name.',
      [{ path: ['name'], message: 'this name is not allowed on a shared tank' }],
    ),
  );

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
    sex: row.sex,
    stage: row.stage,
    lastBroodAtMs: row.lastBroodAt?.getTime() ?? null,
  };
}

function storedLayout(row: TankRow) {
  return row.decorLayout === null ? [] : decorLayoutSchema.parse(row.decorLayout);
}

export function storedBackground(row: TankRow) {
  if (row.backgroundId !== null) {
    const stored = backgroundIdSchema.safeParse(row.backgroundId);
    if (!stored.success) {
      throw new Error(
        `tank ${row.id} stores unknown background "${row.backgroundId}"; migrate it to NULL`,
      );
    }
    return stored.data;
  }
  if (!isPlayableBiome(row.biome)) {
    throw new Error(`tank ${row.id} is in the ${row.biome} biome, which has no backgrounds yet`);
  }
  return DEFAULT_BACKGROUND_ID[row.biome];
}

function hasShelter(row: TankRow): boolean {
  return storedLayout(row).some((item) => BREEDING_SHELTER_ASSET_IDS.includes(item.assetId));
}

function hasVacationFeeder(row: TankRow): boolean {
  return storedLayout(row).some((item) => item.assetId === VACATION_FEEDER_ASSET_ID);
}

interface Ticked {
  tank: TankRow;
  fishRows: FishRow[];
  state: LifecycleState;
  away: AwaySummary | null;
  nowMs: number;
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
    chemistry: chemistrySchema.parse(tank.chemistry),
    fish: fishRows.map(toLifecycleFish),
  };
  const result = catchUp({
    state: initial,
    fromMs: tank.lastTickAt.getTime(),
    toMs: now,
    biome: tank.biome,
    litres: TANK_SIZES[tank.size].litres,
    bioloadCapacity: BIOLOAD_CAPACITY_BY_SIZE[tank.size],
    equipment: equipmentSchema.parse(tank.equipment),
    species: new Map([...deps.species].map(([id, s]) => [id, s.lifecycle])),
    speciesChemistry: new Map([...deps.species].map(([id, s]) => [id, s.chemistry])),
    params: DEFAULT_WATER_PARAMETERS,
    chemistryParams: deps.chemistryParams,
    graceEndsAtMs: user.createdAt.getTime() + GRACE_PERIOD_MS,
    vacationFeeder: hasVacationFeeder(tank),
    breeding: new Map([...deps.species].map(([id, s]) => [id, s.breeding])),
    breedingEnvironment: {
      hasCave: hasShelter(tank),
      maxAnimals: TANK_SIZES[tank.size].maxAnimals,
      bioloadCapacity: BIOLOAD_CAPACITY_BY_SIZE[tank.size],
      newId: randomUUID,
    },
  });

  await tx
    .delete(schema.events)
    .where(
      and(
        eq(schema.events.tankId, tank.id),
        lt(schema.events.at, new Date(now - EVENT_RETENTION_MS)),
      ),
    );

  if (result.steps === 0) return { tank, fishRows, state: initial, away: null, nowMs: now };

  const updatedRows = await persistFish(tx, fishRows, result.state);
  const bornRows = await insertNewborns(tx, tank.id, result.births, result.state, deps);
  const observed: CollectionObservation[] = [];
  const nextStage = new Map(result.state.fish.map((f) => [f.id, f]));
  for (const row of fishRows) {
    if (row.stage !== 'adult' && nextStage.get(row.id)?.stage === 'adult') {
      observed.push({ species: row.species, kind: 'raised', atMs: result.advancedToMs });
    }
  }
  for (const b of result.births) {
    observed.push({ species: b.species, kind: 'bred', atMs: b.bornAtMs });
    if (nextStage.get(b.fishId)?.stage === 'adult') {
      observed.push({ species: b.species, kind: 'raised', atMs: result.advancedToMs });
    }
  }
  await recordCollection(tx, user.id, deps.species, observed, new Date(now));
  const byId = new Map([...fishRows, ...bornRows.values()].map((r) => [r.id, r]));
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
    births: result.births.map((b) => {
      const row = bornRows.get(b.fishId);
      if (!row) throw new Error('lifecycle returned a birth that was not stored');
      return {
        fishId: b.fishId,
        parentId: b.parentId,
        name: row.name,
        species: b.species,
        bornAt: new Date(b.bornAtMs).toISOString(),
      };
    }),
  };
  const advancedTo = new Date(result.advancedToMs);
  await tx
    .update(schema.tanks)
    .set({
      water: result.state.water,
      chemistry: result.state.chemistry,
      lastTickAt: advancedTo,
      updatedAt: new Date(now),
    })
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
  const recentBirths = result.births.filter((b) => b.bornAtMs >= now - EVENT_RETENTION_MS);
  if (recentBirths.length > 0) {
    await tx.insert(schema.events).values(
      recentBirths.map((b) => ({
        tankId: tank.id,
        at: new Date(b.bornAtMs),
        kind: 'born' as const,
        payload: { fishId: b.fishId, parentId: b.parentId, species: b.species },
      })),
    );
  }
  return {
    tank: {
      ...tank,
      water: result.state.water,
      chemistry: result.state.chemistry,
      lastTickAt: advancedTo,
    },
    fishRows: [...updatedRows, ...bornRows.values()],
    state: result.state,
    away,
    nowMs: now,
  };
}

async function insertNewborns(
  tx: Tx,
  tankId: string,
  births: readonly BirthRecord[],
  state: LifecycleState,
  deps: TankRouteDeps,
): Promise<Map<string, FishRow>> {
  const out = new Map<string, FishRow>();
  if (births.length === 0) return out;
  const byId = new Map(state.fish.map((f) => [f.id, f]));
  const values = births.map((b) => {
    const fish = byId.get(b.fishId);
    const spec = deps.species.get(b.species);
    if (!fish || !spec)
      throw new Error('lifecycle returned a birth for an unknown fish or species');
    return {
      id: b.fishId,
      tankId,
      species: b.species,
      name: `${spec.commonName} fry`.slice(0, 40),
      sex: fish.sex,
      stage: fish.stage,
      status: fish.alive ? ('alive' as const) : ('dead' as const),
      diedAt: fish.diedAtMs === null ? null : new Date(fish.diedAtMs),
      cause: fish.cause,
      lastBroodAt: fish.lastBroodAtMs === null ? null : new Date(fish.lastBroodAtMs),
      personality: personalityFromFishId(b.fishId),
      bornAt: new Date(b.bornAtMs),
      size: fish.size,
      hunger: fish.hunger,
      health: fish.health,
    };
  });
  for (const row of await tx.insert(schema.fish).values(values).returning()) out.set(row.id, row);
  return out;
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
      stage: f.stage,
      lastBroodAt: f.lastBroodAtMs === null ? null : new Date(f.lastBroodAtMs),
    };
    const dirty =
      changed.hunger !== row.hunger ||
      changed.health !== row.health ||
      changed.size !== row.size ||
      changed.status !== row.status ||
      changed.stage !== row.stage ||
      changed.lastBroodAt?.getTime() !== row.lastBroodAt?.getTime();
    if (dirty) await tx.update(schema.fish).set(changed).where(eq(schema.fish.id, row.id));
    out.push(dirty ? { ...row, ...changed } : row);
  }
  return out;
}

async function persistState(tx: Tx, tank: TankRow, fishRows: FishRow[], state: LifecycleState) {
  await tx
    .update(schema.tanks)
    .set({ water: state.water, chemistry: state.chemistry })
    .where(eq(schema.tanks.id, tank.id));
  return persistFish(tx, fishRows, state);
}

async function render(
  tx: Tx,
  ticked: Ticked,
  fishRows = ticked.fishRows,
  issuedShareToken: string | null = null,
): Promise<Tank> {
  const { tank, away } = ticked;
  const recentVisitDays = await countRecentVisitDays(tx, tank.id, ticked.nowMs);
  const memorials = await tx
    .select()
    .from(schema.memorials)
    .where(eq(schema.memorials.tankId, tank.id))
    .orderBy(desc(schema.memorials.diedAt));
  return tankSchema.parse({
    id: tank.id,
    name: tank.name,
    biome: tank.biome,
    size: tank.size,
    quarantine: tank.quarantine,
    shared: tank.shareTokenHash !== null,
    shareToken: issuedShareToken,
    decorLayout: storedLayout(tank).map((item) => ({
      ...item,
      tintSeed: item.tintSeed ?? legacyTintSeed(item),
    })),
    decorEdited: tank.decorLayout !== null,
    backgroundId: storedBackground(tank),
    water: tank.water,
    lastTickAt: tank.lastTickAt.toISOString(),
    chemistry: chemistrySchema.parse(tank.chemistry),
    equipment: equipmentSchema.parse(tank.equipment),
    recentVisitDays,
    fish: fishRows
      .toSorted((a, b) => a.bornAt.getTime() - b.bornAt.getTime() || a.id.localeCompare(b.id))
      .map((f) => ({
        id: f.id,
        tankId: f.tankId,
        species: f.species,
        name: f.name,
        sex: f.sex,
        stage: f.stage,
        personality: personalitySchema.parse(f.personality),
        disease: f.disease === null ? null : diseaseStateSchema.parse(f.disease),
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
  const { app, database, species, chemistryParams, clock, limiter, limits } = deps;

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
        const owned = await tx
          .select({ quarantine: schema.tanks.quarantine })
          .from(schema.tanks)
          .where(eq(schema.tanks.ownerId, user.id));
        const quarantined = owned.filter((t) => t.quarantine).length;
        if (body.quarantine && quarantined >= MAX_QUARANTINE_TANKS) {
          throw new HttpError(409, apiError('conflict', 'You already have a quarantine tank.'));
        }
        if (!body.quarantine && owned.length - quarantined >= MAX_DISPLAY_TANKS) {
          throw new HttpError(
            409,
            apiError('conflict', `You can have at most ${MAX_DISPLAY_TANKS} display tanks.`),
          );
        }
        const [row] = await tx
          .insert(schema.tanks)
          .values({
            ownerId: user.id,
            name: body.name,
            biome: body.biome,
            size: body.size,
            quarantine: body.quarantine,
            chemistry: newTankChemistry(body.biome),
            lastTickAt: new Date(clock.now()),
          })
          .returning();
        if (!row) throw new Error('tank insert returned no row');
        return render(tx, {
          tank: row,
          fishRows: [],
          state: {
            water: waterSchema.parse(row.water),
            chemistry: chemistrySchema.parse(row.chemistry),
            fish: [],
          },
          away: null,
          nowMs: clock.now(),
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
      return withTank(user, tankId, async (tx, ticked) => {
        await recordVisit(tx, ticked.tank.id, ticked.nowMs);
        return render(tx, ticked);
      });
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
        if (
          body.name !== undefined &&
          ticked.tank.shareTokenHash !== null &&
          containsBlockedWord(body.name)
        ) {
          throw nameNotPublic();
        }
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
        if (
          body.backgroundId !== undefined &&
          body.backgroundId !== null &&
          !isBackgroundForBiome(ticked.tank.biome, body.backgroundId)
        ) {
          throw new HttpError(
            400,
            apiError(
              'validation_failed',
              `That background does not belong in a ${ticked.tank.biome} tank.`,
              [{ path: ['backgroundId'], message: 'not a background for this tank biome' }],
            ),
          );
        }
        const [row] = await tx
          .update(schema.tanks)
          .set({
            ...(body.backgroundId !== undefined ? { backgroundId: body.backgroundId } : {}),
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
    '/api/tanks/:tankId/share',
    guarded(async (req) => {
      const user = await authorize(req);
      const { tankId } = tankParamsSchema.parse(req.params);
      throttle(user.id, 'care');
      return withTank(user, tankId, async (tx, ticked) => {
        if (ticked.tank.shareTokenHash !== null) return render(tx, ticked);
        if (containsBlockedWord(ticked.tank.name)) {
          throw new HttpError(
            400,
            apiError(
              'validation_failed',
              'This tank name is not allowed on a shared tank. Rename the tank first.',
              [{ path: ['name'], message: 'this name is not allowed on a shared tank' }],
            ),
          );
        }
        const issued = issueShareToken();
        const [row] = await tx
          .update(schema.tanks)
          .set({ shareTokenHash: issued.hash })
          .where(eq(schema.tanks.id, tankId))
          .returning();
        await audit(tx, { action: 'share_enabled', actorId: user.id, tankId });
        return render(tx, { ...ticked, tank: row ?? ticked.tank }, undefined, issued.token);
      });
    }),
  );

  app.post(
    '/api/tanks/:tankId/share/rotate',
    guarded(async (req) => {
      const user = await authorize(req);
      const { tankId } = tankParamsSchema.parse(req.params);
      throttle(user.id, 'care');
      return withTank(user, tankId, async (tx, ticked) => {
        if (ticked.tank.shareTokenHash === null) {
          throw new HttpError(
            409,
            apiError('conflict', 'This tank is not shared. Share it first.'),
          );
        }
        const issued = issueShareToken();
        const [row] = await tx
          .update(schema.tanks)
          .set({ shareTokenHash: issued.hash })
          .where(eq(schema.tanks.id, tankId))
          .returning();
        await audit(tx, { action: 'share_rotated', actorId: user.id, tankId });
        return render(tx, { ...ticked, tank: row ?? ticked.tank }, undefined, issued.token);
      });
    }),
  );

  app.delete(
    '/api/tanks/:tankId/share',
    guarded(async (req) => {
      const user = await authorize(req);
      const { tankId } = tankParamsSchema.parse(req.params);
      throttle(user.id, 'care');
      return withTank(user, tankId, async (tx, ticked) => {
        const wasShared = ticked.tank.shareTokenHash !== null;
        const [row] = await tx
          .update(schema.tanks)
          .set({ shareTokenHash: null })
          .where(eq(schema.tanks.id, tankId))
          .returning();
        if (wasShared) await audit(tx, { action: 'share_revoked', actorId: user.id, tankId });
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
            BIOLOAD_CAPACITY_BY_SIZE[ticked.tank.size],
            TANK_SIZES[ticked.tank.size].maxAnimals,
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
        const id = randomUUID();
        const [row] = await tx
          .insert(schema.fish)
          .values({
            id,
            tankId,
            species: spec.id,
            name: body.name,
            sex: randomInt(2) === 0 ? 'male' : 'female',
            personality: personalityFromFishId(id),
            bornAt: new Date(clock.now()),
            size: spec.lifecycle.birthSizeM,
          })
          .returning();
        if (!row) throw new Error('fish insert returned no row');
        await recordCollection(
          tx,
          user.id,
          species,
          [{ species: spec.id, kind: 'kept', atMs: row.bornAt.getTime() }],
          row.bornAt,
        );
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
        const applied = applyCare(ticked.state, action, ticked.tank.biome, chemistryParams);
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
        const tank = {
          ...ticked.tank,
          water: applied.value.water,
          chemistry: applied.value.chemistry,
        };
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
        const tank = {
          ...ticked.tank,
          water: applied.value.water,
          chemistry: applied.value.chemistry,
        };
        return { tank: await render(tx, { ...ticked, tank }, fishRows) };
      });
      return result.tank;
    }),
  );
}
