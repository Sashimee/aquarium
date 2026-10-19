import {
  apiErrorSchema,
  decorLayoutSchema,
  DEFAULT_EQUIPMENT,
  personalitySchema,
  decorPositionLimits,
  DEFAULT_BACKGROUND_ID,
  legacyTintSeed,
  newTankChemistry,
  shareTokenSchema,
  TANK_SIZES,
  speciesListSchema,
  tankListSchema,
  tankSchema,
} from '@aquarium/shared';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MAX_FISH_PER_TANK } from '@aquarium/sim/lifecycle';
import { schema } from './db/index.ts';
import { DEFAULT_CARE_LIMITS } from './tanks.ts';
import { pruneExpired } from './maintenance.ts';
import { APP_ORIGIN, createHarness, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
let counter = 0;

function cookieOf(res: LightMyRequestResponse): string {
  return res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function signedIn(h: Harness): Promise<string> {
  const email = `t12-${Date.now()}-${counter++}@bas.lu`;
  await h.app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: jsonHeaders,
    payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/verify-email' },
  });
  const mail = h.outbox.findLast((m) => m.to === email);
  const link = /https?:\/\/\S+verify-email\?\S+/.exec(mail?.text ?? '')?.[0];
  if (!link) throw new Error('no verification link');
  const url = new URL(link);
  const verify = await h.app.inject(url.pathname + url.search);
  const cookie = cookieOf(verify);
  if (!cookie) throw new Error('verification did not sign in');
  return cookie;
}

function call(
  h: Harness,
  cookie: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return h.app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

async function createTank(h: Harness, cookie: string, biome: 'freshwater' | 'reef' = 'freshwater') {
  const res = await call(h, cookie, 'POST', '/api/tanks', { name: 'Home', biome });
  expect(res.statusCode).toBe(201);
  return tankSchema.parse(res.json());
}

async function addFish(
  h: Harness,
  cookie: string,
  tankId: string,
  species = 'neon-tetra',
  name = 'Blip',
) {
  const res = await call(h, cookie, 'POST', `/api/tanks/${tankId}/fish`, { species, name });
  expect(res.statusCode).toBe(201);
  return tankSchema.parse(res.json());
}

const advance = (h: Harness, minutes: number) =>
  h.app.inject({
    method: 'POST',
    url: '/api/test/advance-time',
    headers: jsonHeaders,
    payload: { minutes },
  });

const DAY = 24 * 60;

describe('tanks and fish', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('requires a session for every route', async () => {
    for (const [method, url] of [
      ['GET', '/api/tanks'],
      ['POST', '/api/tanks'],
      ['GET', '/api/species'],
      ['GET', '/api/tanks/3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b'],
    ] as const) {
      const res = await h.app.inject({
        method,
        url,
        headers: jsonHeaders,
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(apiErrorSchema.parse(res.json()).error.code).toBe('unauthenticated');
    }
  });

  it('lists the species catalogue with lifecycle blocks', async () => {
    const cookie = await signedIn(h);
    const res = await call(h, cookie, 'GET', '/api/species');
    const list = speciesListSchema.parse(res.json());
    expect(list.map((s) => s.id)).toContain('neon-tetra');
    expect(list.find((s) => s.id === 'blue-tang')?.biome).toBe('reef');
  });

  it('serves cycled chemistry, default equipment and adult neutral fish on a new tank', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    expect(tank.chemistry).toEqual(newTankChemistry('freshwater'));
    expect(tank.equipment).toEqual(DEFAULT_EQUIPMENT);
    const stocked = await addFish(h, cookie, tank.id);
    expect(stocked.fish[0]).toMatchObject({
      stage: 'adult',
      disease: null,
    });
    expect(personalitySchema.safeParse(stocked.fish[0]?.personality).success).toBe(true);
  });

  it('serves breeding and chemistry tolerances with defaults for species that declare none', async () => {
    const cookie = await signedIn(h);
    const list = speciesListSchema.parse((await call(h, cookie, 'GET', '/api/species')).json());
    const neon = list.find((s) => s.id === 'neon-tetra');
    expect(neon?.breeding).toEqual({ mode: 'none', needsPair: true, needsCave: false });
    expect(neon?.chemistry.phRange).toEqual([6, 8.5]);
  });

  it('creates, lists, renames and re-lays-out a tank, and validates input', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    expect(tank).toMatchObject({ name: 'Home', biome: 'freshwater', fish: [], memorials: [] });
    expect(tank.water).toEqual({ ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 0 });

    const list = tankListSchema.parse((await call(h, cookie, 'GET', '/api/tanks')).json());
    expect(list.map((t) => t.id)).toEqual([tank.id]);

    const patched = tankSchema.parse(
      (await call(h, cookie, 'PATCH', `/api/tanks/${tank.id}`, { name: 'Renamed' })).json(),
    );
    expect(patched.name).toBe('Renamed');

    const bad = await call(h, cookie, 'POST', '/api/tanks', { name: '', biome: 'lake' });
    expect(bad.statusCode).toBe(400);
    expect(apiErrorSchema.parse(bad.json()).error.code).toBe('validation_failed');
    expect((await call(h, cookie, 'GET', '/api/tanks/not-a-uuid')).statusCode).toBe(400);
    expect((await call(h, cookie, 'PATCH', `/api/tanks/${tank.id}`, {})).statusCode).toBe(400);
  });

  it('starts on the biome default background and lets the owner change it', async () => {
    const cookie = await signedIn(h);
    const fresh = await createTank(h, cookie);
    const reef = await createTank(h, cookie, 'reef');
    expect(fresh.backgroundId).toBe(DEFAULT_BACKGROUND_ID.freshwater);
    expect(reef.backgroundId).toBe(DEFAULT_BACKGROUND_ID.reef);

    const set = await call(h, cookie, 'PATCH', `/api/tanks/${fresh.id}`, {
      backgroundId: 'bg-fw-misty-lake',
    });
    expect(set.statusCode).toBe(200);
    expect(tankSchema.parse(set.json()).backgroundId).toBe('bg-fw-misty-lake');
    const reloaded = tankSchema.parse(
      (await call(h, cookie, 'GET', `/api/tanks/${fresh.id}`)).json(),
    );
    expect(reloaded.backgroundId).toBe('bg-fw-misty-lake');

    const renamed = await call(h, cookie, 'PATCH', `/api/tanks/${fresh.id}`, { name: 'Again' });
    expect(tankSchema.parse(renamed.json()).backgroundId).toBe('bg-fw-misty-lake');
  });

  it('rejects a background from another biome or an unknown one', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    const wrongBiome = await call(h, cookie, 'PATCH', `/api/tanks/${tank.id}`, {
      backgroundId: 'bg-reef-coral-wall',
    });
    expect(wrongBiome.statusCode).toBe(400);
    expect(apiErrorSchema.parse(wrongBiome.json()).error.code).toBe('validation_failed');
    const unknown = await call(h, cookie, 'PATCH', `/api/tanks/${tank.id}`, {
      backgroundId: 'nope',
    });
    expect(unknown.statusCode).toBe(400);
    for (const res of [wrongBiome, unknown]) {
      expect(apiErrorSchema.parse(res.json()).error.code).toBe('validation_failed');
    }
    expect(JSON.stringify(wrongBiome.json())).toContain('backgroundId');
    const after = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
    expect(after.backgroundId).toBe(DEFAULT_BACKGROUND_ID.freshwater);
  });

  it('leaves the name alone when the background in the same PATCH is rejected', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    const res = await call(h, cookie, 'PATCH', `/api/tanks/${tank.id}`, {
      name: 'Renamed',
      backgroundId: 'bg-reef-coral-wall',
    });
    expect(res.statusCode).toBe(400);
    const after = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
    expect(after.name).toBe(tank.name);
  });

  it('returns to the biome default when the background is set to null', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    await call(h, cookie, 'PATCH', `/api/tanks/${tank.id}`, { backgroundId: 'bg-fw-misty-lake' });
    const res = await call(h, cookie, 'PATCH', `/api/tanks/${tank.id}`, { backgroundId: null });
    expect(res.statusCode).toBe(200);
    expect(tankSchema.parse(res.json()).backgroundId).toBe(DEFAULT_BACKGROUND_ID.freshwater);
    const [row] = await h.database.db
      .select()
      .from(schema.tanks)
      .where(eq(schema.tanks.id, tank.id));
    expect(row?.backgroundId).toBeNull();
  });

  it('fails loudly when a stored background id is no longer a known slot', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    await h.database.db
      .update(schema.tanks)
      .set({ backgroundId: 'bg-retired' })
      .where(eq(schema.tanks.id, tank.id));
    const res = await call(h, cookie, 'GET', `/api/tanks/${tank.id}`);
    expect(res.statusCode).toBe(500);
  });

  it('does not let another user set a background', async () => {
    const alice = await signedIn(h);
    const bob = await signedIn(h);
    const tank = await createTank(h, alice);
    const res = await call(h, bob, 'PATCH', `/api/tanks/${tank.id}`, {
      backgroundId: 'bg-fw-root-tangle',
    });
    expect(res.statusCode).toBe(404);
  });

  it('keeps tanks private to their owner', async () => {
    const alice = await signedIn(h);
    const bob = await signedIn(h);
    const tank = await createTank(h, alice);
    for (const [method, url, payload] of [
      ['GET', `/api/tanks/${tank.id}`, undefined],
      ['PATCH', `/api/tanks/${tank.id}`, { name: 'Mine now' }],
      ['POST', `/api/tanks/${tank.id}/fish`, { species: 'guppy', name: 'x' }],
      ['POST', `/api/tanks/${tank.id}/care`, { type: 'water_change' }],
    ] as const) {
      const res = await call(h, bob, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(tankListSchema.parse((await call(h, bob, 'GET', '/api/tanks')).json())).toEqual([]);
  });

  it('limits a user to six display tanks and one quarantine tank', async () => {
    const cookie = await signedIn(h);
    for (let i = 0; i < 6; i++) await createTank(h, cookie, i % 2 ? 'reef' : 'freshwater');
    const seventh = await call(h, cookie, 'POST', '/api/tanks', { name: 'Seven', biome: 'reef' });
    expect(seventh.statusCode).toBe(409);

    const quarantine = await call(h, cookie, 'POST', '/api/tanks', {
      name: 'Quarantine',
      biome: 'freshwater',
      size: 'nano30',
      quarantine: true,
    });
    expect(quarantine.statusCode).toBe(201);
    expect(tankSchema.parse(quarantine.json())).toMatchObject({ quarantine: true, size: 'nano30' });

    const second = await call(h, cookie, 'POST', '/api/tanks', {
      name: 'Quarantine 2',
      biome: 'freshwater',
      size: 'nano30',
      quarantine: true,
    });
    expect(second.statusCode).toBe(409);
  });

  it('assigns each fish a sex and keeps it across reads', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    let latest = tank;
    for (let i = 0; i < 12; i++) latest = await addFish(h, cookie, tank.id);
    const sexes = latest.fish.map((f) => f.sex);
    expect(sexes.every((s) => s === 'male' || s === 'female')).toBe(true);
    const reread = await call(h, cookie, 'GET', `/api/tanks/${tank.id}`);
    expect(reread.json<typeof latest>().fish.map((f) => f.sex)).toEqual(sexes);
  });

  it('adds fish with the species birth size and refuses wrong-biome and unknown species', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    const withFish = await addFish(h, cookie, tank.id);
    expect(withFish.fish[0]).toMatchObject({
      species: 'neon-tetra',
      name: 'Blip',
      status: 'alive',
      hunger: 0,
      health: 1,
      size: 0.012,
    });
    const reefFish = await call(h, cookie, 'POST', `/api/tanks/${tank.id}/fish`, {
      species: 'blue-tang',
      name: 'Dory',
    });
    expect(reefFish.statusCode).toBe(400);
    const unknown = await call(h, cookie, 'POST', `/api/tanks/${tank.id}/fish`, {
      species: 'kraken',
      name: 'x',
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('enforces the bioload capacity of a tank', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    for (let i = 0; i < 10; i++) await addFish(h, cookie, tank.id, 'angelfish', `A${i}`);
    const res = await call(h, cookie, 'POST', `/api/tanks/${tank.id}/fish`, {
      species: 'angelfish',
      name: 'Too many',
    });
    expect(res.statusCode).toBe(409);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('conflict');
  });
});

describe('server-authoritative lifecycle', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.close());

  it('starves an untended fish, reports it as away, and lets the user net it into the memorial', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    const { fish } = await addFish(h, cookie, tank.id);
    const fishId = fish[0]?.id ?? '';

    await advance(h, 1 * DAY);
    const early = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
    expect(early.fish[0]?.hunger).toBeGreaterThan(0.15);
    expect(early.fish[0]?.health).toBe(1);
    expect(early.away).toMatchObject({ capped: false, deaths: [] });

    expect(
      (await call(h, cookie, 'DELETE', `/api/tanks/${tank.id}/fish/${fishId}`)).statusCode,
    ).toBe(409);

    await advance(h, 12 * DAY);
    const late = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
    expect(late.fish[0]).toMatchObject({ status: 'dead', cause: 'starvation', health: 0 });
    expect(late.away?.deaths).toHaveLength(1);
    expect(late.away?.deaths[0]).toMatchObject({ fishId, name: 'Blip', cause: 'starvation' });

    const again = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
    expect(again.away?.deaths ?? []).toHaveLength(0);

    const netted = tankSchema.parse(
      (await call(h, cookie, 'DELETE', `/api/tanks/${tank.id}/fish/${fishId}`)).json(),
    );
    expect(netted.fish).toEqual([]);
    expect(netted.memorials).toHaveLength(1);
    expect(netted.memorials[0]).toMatchObject({
      fishName: 'Blip',
      species: 'neon-tetra',
      cause: 'starvation',
    });
    expect(
      (await call(h, cookie, 'DELETE', `/api/tanks/${tank.id}/fish/${fishId}`)).statusCode,
    ).toBe(404);

    const deathEvents = await h.database.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.tankId, tank.id));
    expect(deathEvents.filter((e) => e.kind === 'death')).toHaveLength(1);
  });

  it('persists the catch-up on a read and carries the sub-step remainder', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    await addFish(h, cookie, tank.id);
    await advance(h, 25);
    await call(h, cookie, 'GET', `/api/tanks/${tank.id}`);
    const [row] = await h.database.db
      .select()
      .from(schema.tanks)
      .where(eq(schema.tanks.id, tank.id));
    const [fish] = await h.database.db
      .select()
      .from(schema.fish)
      .where(eq(schema.fish.tankId, tank.id));
    expect(fish?.hunger).toBeGreaterThan(0);
    const lagMs = h.clock.now() - (row?.lastTickAt.getTime() ?? 0);
    expect(lagMs).toBeGreaterThanOrEqual(0);
    expect(lagMs).toBeLessThan(10 * 60_000 + 5_000);
  });

  it('breeds a fed pair in range, stores the fry and reports them as away', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    await addFish(h, cookie, tank.id, 'guppy', 'Mum');
    const withBoth = await addFish(h, cookie, tank.id, 'guppy', 'Dad');
    const [mum, dad] = withBoth.fish;
    const grownUp = new Date(h.clock.now() - 400 * DAY * 60_000);
    await h.database.db
      .update(schema.fish)
      .set({ sex: 'female', bornAt: grownUp })
      .where(eq(schema.fish.id, mum?.id ?? ''));
    await h.database.db
      .update(schema.fish)
      .set({ sex: 'male', bornAt: grownUp })
      .where(eq(schema.fish.id, dad?.id ?? ''));

    let seen = null;
    for (let i = 0; i < 40 && !seen; i++) {
      await h.database.db
        .update(schema.fish)
        .set({ hunger: 0 })
        .where(eq(schema.fish.tankId, tank.id));
      await advance(h, 6 * 60);
      const read = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
      if (read.away?.births?.length) seen = read;
    }
    if (!seen) throw new Error('no brood within 10 simulated days');

    const fry = seen.fish.filter((f) => f.stage === 'fry');
    expect(fry.length).toBe(seen.away?.births?.length);
    expect(fry.length).toBeGreaterThanOrEqual(3);
    expect(fry.length).toBeLessThanOrEqual(8);
    expect(fry.every((f) => f.species === 'guppy' && f.status === 'alive')).toBe(true);
    expect(seen.away?.births?.every((b) => b.parentId === mum?.id)).toBe(true);
    expect(seen.fish.filter((f) => f.status === 'alive').length).toBeLessThanOrEqual(
      TANK_SIZES.standard.maxAnimals,
    );

    const [parent] = await h.database.db
      .select()
      .from(schema.fish)
      .where(eq(schema.fish.id, mum?.id ?? ''));
    expect(parent?.lastBroodAt).not.toBeNull();
    const events = await h.database.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.tankId, tank.id));
    expect(events.filter((e) => e.kind === 'born')).toHaveLength(fry.length);

    const again = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
    expect(again.away?.births ?? []).toHaveLength(0);
    expect(again.fish.filter((f) => f.stage === 'fry')).toHaveLength(fry.length);
  });

  it('gives a new account 48 h of grace, then the fish starve', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    await addFish(h, cookie, tank.id);
    await h.database.db
      .update(schema.fish)
      .set({ hunger: 0.9 })
      .where(eq(schema.fish.tankId, tank.id));
    await advance(h, 40 * 60);
    const inGrace = tankSchema.parse(
      (await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json(),
    );
    expect(inGrace.fish[0]?.health).toBe(1);
    await advance(h, 3 * DAY);
    const after = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
    expect(after.fish[0]?.health).toBeLessThan(1);
  });

  it('caps catch-up at 60 days and moves last-tick to now', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    await addFish(h, cookie, tank.id);
    await advance(h, 200 * DAY);
    const res = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
    expect(res.away?.capped).toBe(true);
    expect(res.away?.elapsedMinutes).toBe(60 * DAY);
    expect(Date.parse(res.lastTickAt)).toBeGreaterThan(h.clock.now() - 60_000);
  });

  it('serialises concurrent requests on one tank through the row lock', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    await addFish(h, cookie, tank.id);
    await advance(h, 2 * DAY);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => call(h, cookie, 'GET', `/api/tanks/${tank.id}`)),
    );
    const tanks = responses.map((r) => {
      expect(r.statusCode).toBe(200);
      return tankSchema.parse(r.json());
    });
    const hungers = new Set(tanks.map((t) => t.fish[0]?.hunger));
    expect(hungers.size).toBe(1);
    const withAway = tanks.filter((t) => (t.away?.elapsedMinutes ?? 0) > 0);
    expect(withAway).toHaveLength(1);
  });

  it('halves hunger growth while a vacation feeder is placed', async () => {
    const cookie = await signedIn(h);
    const plain = await createTank(h, cookie);
    const fed = await createTank(h, cookie);
    await addFish(h, cookie, plain.id);
    await addFish(h, cookie, fed.id);
    await call(h, cookie, 'PATCH', `/api/tanks/${fed.id}`, {
      decorLayout: [{ assetId: 'vacation-feeder', position: [0, 0, 0] }],
    });
    await advance(h, 2 * DAY);
    const a = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${plain.id}`)).json());
    const b = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${fed.id}`)).json());
    expect((b.fish[0]?.hunger ?? 0) * 2).toBeCloseTo(a.fish[0]?.hunger ?? 0, 2);
  });

  it('trims events older than 90 days on the next tick', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    await h.database.db.insert(schema.events).values({
      tankId: tank.id,
      at: new Date(h.clock.now() - 100 * DAY * 60_000),
      kind: 'water_change',
    });
    await call(h, cookie, 'GET', `/api/tanks/${tank.id}`);
    const rows = await h.database.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.tankId, tank.id));
    expect(rows).toHaveLength(0);
  });
});

describe('care actions and feeding validation', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({
      careLimits: {
        feed: { max: 6, windowMs: 60_000 },
        care: { max: 5, windowMs: 60_000 },
        ate: { max: 4, windowMs: 60_000 },
        addFish: { max: 100, windowMs: 60_000 },
      },
    });
  });
  afterEach(() => h.close());

  async function setup(biome: 'freshwater' | 'reef' = 'freshwater') {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie, biome);
    const withFish = await addFish(
      h,
      cookie,
      tank.id,
      biome === 'reef' ? 'royal-gramma' : 'neon-tetra',
    );
    return { cookie, tank: withFish, fishId: withFish.fish[0]?.id ?? '' };
  }

  const feed = (cookie: string, tankId: string, portion = 1, food = 'flakes') =>
    call(h, cookie, 'POST', `/api/tanks/${tankId}/care`, { type: 'feed', food, portion });

  const ate = (
    cookie: string,
    tankId: string,
    fishId: string,
    portion: number,
    at = new Date(h.clock.now()).toISOString(),
  ) => call(h, cookie, 'POST', `/api/tanks/${tankId}/ate`, { reports: [{ fishId, portion, at }] });

  it('feeds, accepts matching consumption, and lowers hunger', async () => {
    const { cookie, tank, fishId } = await setup();
    await advance(h, DAY);
    const hungry = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
    const before = hungry.fish[0]?.hunger ?? 0;
    const fed = tankSchema.parse((await feed(cookie, tank.id, 1)).json());
    expect(fed.water.uneatenFood).toBe(1);

    const eaten = tankSchema.parse(
      (await ate(cookie, tank.id, fishId, 0.75, new Date(h.clock.now()).toISOString())).json(),
    );
    expect(eaten.water.uneatenFood).toBeCloseTo(0.25);
    expect(eaten.fish[0]?.hunger ?? 1).toBeLessThan(before);
  });

  it('rejects consumption beyond the food dropped, with feeding_rejected', async () => {
    const { cookie, tank, fishId } = await setup();
    await feed(cookie, tank.id, 1);
    const res = await ate(cookie, tank.id, fishId, 1.5);
    expect(res.statusCode).toBe(422);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('feeding_rejected');
    const none = await ate(cookie, (await setup()).tank.id, fishId, 0.1);
    expect(none.statusCode).toBe(404);
  });

  it('counts earlier reports against the same window', async () => {
    const { cookie, tank, fishId } = await setup();
    await feed(cookie, tank.id, 1);
    expect((await ate(cookie, tank.id, fishId, 0.6)).statusCode).toBe(200);
    expect((await ate(cookie, tank.id, fishId, 0.6)).statusCode).toBe(422);
  });

  describe('batch idempotency', () => {
    const ateBatch = (cookie: string, tankId: string, fishId: string, batchId?: string) =>
      call(h, cookie, 'POST', `/api/tanks/${tankId}/ate`, {
        ...(batchId !== undefined ? { batchId } : {}),
        reports: [{ fishId, portion: 0.3, at: new Date(h.clock.now()).toISOString() }],
      });
    const ateEvents = async (tankId: string) =>
      (
        await h.database.db.select().from(schema.events).where(eq(schema.events.tankId, tankId))
      ).filter((r) => r.kind === 'ate');

    it('applies a repeated batch id once and answers the repeat with the same success', async () => {
      const { cookie, tank, fishId } = await setup();
      await feed(cookie, tank.id, 1);
      const batchId = randomUUID();
      const first = await ateBatch(cookie, tank.id, fishId, batchId);
      const repeat = await ateBatch(cookie, tank.id, fishId, batchId);
      expect(first.statusCode).toBe(200);
      expect(repeat.statusCode).toBe(200);
      expect(tankSchema.parse(repeat.json()).water.uneatenFood).toBeCloseTo(0.7);
      expect(await ateEvents(tank.id)).toHaveLength(1);
    });

    it('applies concurrent duplicates once', async () => {
      const { cookie, tank, fishId } = await setup();
      await feed(cookie, tank.id, 1);
      const batchId = randomUUID();
      const responses = await Promise.all([
        ateBatch(cookie, tank.id, fishId, batchId),
        ateBatch(cookie, tank.id, fishId, batchId),
        ateBatch(cookie, tank.id, fishId, batchId),
      ]);
      expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
      expect(await ateEvents(tank.id)).toHaveLength(1);
      const after = tankSchema.parse(
        (await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json(),
      );
      expect(after.water.uneatenFood).toBeCloseTo(0.7);
    });

    it('scopes a batch id to its tank', async () => {
      const a = await setup();
      const second = await createTank(h, a.cookie);
      const withFish = await addFish(h, a.cookie, second.id);
      const otherFish = withFish.fish[0]?.id ?? '';
      await feed(a.cookie, a.tank.id, 1);
      await feed(a.cookie, second.id, 1);
      const batchId = randomUUID();
      expect((await ateBatch(a.cookie, a.tank.id, a.fishId, batchId)).statusCode).toBe(200);
      expect((await ateBatch(a.cookie, second.id, otherFish, batchId)).statusCode).toBe(200);
      expect(await ateEvents(a.tank.id)).toHaveLength(1);
      expect(await ateEvents(second.id)).toHaveLength(1);
    });

    it('does not consume the id when the batch is rejected', async () => {
      const { cookie, tank, fishId } = await setup();
      const batchId = randomUUID();
      expect((await ateBatch(cookie, tank.id, fishId, batchId)).statusCode).toBe(422);
      await feed(cookie, tank.id, 1);
      expect((await ateBatch(cookie, tank.id, fishId, batchId)).statusCode).toBe(200);
      expect(await ateEvents(tank.id)).toHaveLength(1);
    });

    it('rejects a stale report under a pruned batch id and rolls the claim back', async () => {
      const { cookie, tank, fishId } = await setup();
      await feed(cookie, tank.id, 1);
      const old = randomUUID();
      await h.database.db.insert(schema.ateBatches).values({
        tankId: tank.id,
        batchId: old,
        createdAt: new Date(Date.now() - 2 * DAY * 60_000),
      });
      await pruneExpired(h.database);
      const stale = await call(h, cookie, 'POST', `/api/tanks/${tank.id}/ate`, {
        batchId: old,
        reports: [
          { fishId, portion: 0.3, at: new Date(h.clock.now() - 3 * 60 * 60_000).toISOString() },
        ],
      });
      expect(stale.statusCode).toBe(422);
      expect(apiErrorSchema.parse(stale.json()).error.code).toBe('feeding_rejected');
      expect(await ateEvents(tank.id)).toHaveLength(0);
      const claims = await h.database.db
        .select()
        .from(schema.ateBatches)
        .where(eq(schema.ateBatches.tankId, tank.id));
      expect(claims).toHaveLength(0);
      const fresh = await ateBatch(cookie, tank.id, fishId, randomUUID());
      expect(fresh.statusCode).toBe(200);
    });

    it('rejects a malformed batch id with 400', async () => {
      const { cookie, tank, fishId } = await setup();
      await feed(cookie, tank.id, 1);
      for (const bad of ['', 'not-a-uuid', 'x'.repeat(5000)]) {
        expect((await ateBatch(cookie, tank.id, fishId, bad)).statusCode).toBe(400);
      }
      expect(await ateEvents(tank.id)).toHaveLength(0);
    });

    it('still accepts batches without an id, from clients cached before the field existed', async () => {
      const { cookie, tank, fishId } = await setup();
      await feed(cookie, tank.id, 1);
      expect((await ateBatch(cookie, tank.id, fishId)).statusCode).toBe(200);
      expect((await ateBatch(cookie, tank.id, fishId)).statusCode).toBe(200);
      expect(await ateEvents(tank.id)).toHaveLength(2);
    });

    it('prunes stored ids after a day', async () => {
      const { cookie, tank, fishId } = await setup();
      await feed(cookie, tank.id, 1);
      await ateBatch(cookie, tank.id, fishId, randomUUID());
      const old = randomUUID();
      await h.database.db.insert(schema.ateBatches).values({
        tankId: tank.id,
        batchId: old,
        createdAt: new Date(Date.now() - 2 * DAY * 60_000),
      });
      await pruneExpired(h.database);
      const left = await h.database.db
        .select()
        .from(schema.ateBatches)
        .where(eq(schema.ateBatches.tankId, tank.id));
      expect(left).toHaveLength(1);
      expect(left[0]?.batchId).not.toBe(old);
    });
  });

  it('rejects reports for another tank’s fish and malformed batches', async () => {
    const a = await setup();
    const b = await setup();
    await feed(a.cookie, a.tank.id, 1);
    expect((await ate(a.cookie, a.tank.id, b.fishId, 0.1)).statusCode).toBe(422);
    const empty = await call(h, a.cookie, 'POST', `/api/tanks/${a.tank.id}/ate`, { reports: [] });
    expect(empty.statusCode).toBe(400);
  });

  it('rejects food that does not belong in the biome and enforces the rate limit', async () => {
    const { cookie, tank } = await setup();
    const wrong = await feed(cookie, tank.id, 1, 'nori');
    expect(wrong.statusCode).toBe(422);
    expect(apiErrorSchema.parse(wrong.json()).error.code).toBe('feeding_rejected');

    const limited = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++)
      statuses.push((await feed(limited.cookie, limited.tank.id, 0.1)).statusCode);
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true);
    const last = await feed(limited.cookie, limited.tank.id, 0.1);
    expect(last.statusCode).toBe(429);
    expect(apiErrorSchema.parse(last.json()).error.code).toBe('rate_limited');
    expect(last.headers['retry-after']).toBeUndefined();
  });

  it('measures the eating window by server receive time, so backdating cannot evade the per-fish cap', async () => {
    const { cookie, tank, fishId } = await setup();
    await feed(cookie, tank.id, 5);
    await feed(cookie, tank.id, 5);
    const backdated = new Date(h.clock.now() - 119 * 60_000).toISOString();
    expect((await ate(cookie, tank.id, fishId, 2, backdated)).statusCode).toBe(200);
    await advance(h, 2);
    const again = await ate(cookie, tank.id, fishId, 2, backdated);
    expect(again.statusCode).toBe(422);
    expect(apiErrorSchema.parse(again.json()).error.code).toBe('feeding_rejected');
  });

  it('stores one aggregated event per fish per batch and rejects negligible portions', async () => {
    const { cookie, tank, fishId } = await setup();
    await feed(cookie, tank.id, 5);
    const at = new Date(h.clock.now()).toISOString();
    const reports = Array.from({ length: 150 }, () => ({ fishId, portion: 0.01, at }));
    const res = await call(h, cookie, 'POST', `/api/tanks/${tank.id}/ate`, { reports });
    expect(res.statusCode).toBe(200);
    const rows = await h.database.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.tankId, tank.id));
    const eaten = rows.filter((r) => r.kind === 'ate');
    expect(eaten).toHaveLength(1);
    expect((eaten[0]?.payload as { portion: number }).portion).toBeCloseTo(1.5);
    const tiny = await call(h, cookie, 'POST', `/api/tanks/${tank.id}/ate`, {
      reports: [{ fishId, portion: 1e-12, at }],
    });
    expect(tiny.statusCode).toBe(400);
  });

  it('rate-limits non-feed care actions and tank updates together', async () => {
    const { cookie, tank } = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push(
        i % 2
          ? (await call(h, cookie, 'PATCH', `/api/tanks/${tank.id}`, { name: `n${i}` })).statusCode
          : (await call(h, cookie, 'POST', `/api/tanks/${tank.id}/care`, { type: 'algae_scrape' }))
              .statusCode,
      );
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('rate-limits ate batches per user', async () => {
    const { cookie, tank, fishId } = await setup();
    await feed(cookie, tank.id, 2);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await ate(cookie, tank.id, fishId, 0.1)).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 429]);
  });

  it('water change halves ammonia and nitrate, vacuum clears food, scrape clears algae', async () => {
    const { cookie, tank } = await setup();
    await h.database.db
      .update(schema.tanks)
      .set({ water: { ammonia: 0.4, nitrate: 10, algae: 0.6, uneatenFood: 3 } })
      .where(eq(schema.tanks.id, tank.id));
    const post = (type: string) => call(h, cookie, 'POST', `/api/tanks/${tank.id}/care`, { type });
    const wc = tankSchema.parse((await post('water_change')).json());
    expect(wc.water.nitrate).toBeCloseTo(5, 1);
    expect(wc.water.ammonia).toBeCloseTo(0.2, 1);
    expect(tankSchema.parse((await post('gravel_vacuum')).json()).water.uneatenFood).toBe(0);
    expect(tankSchema.parse((await post('algae_scrape')).json()).water.algae).toBe(0);
    expect(
      (await call(h, cookie, 'POST', `/api/tanks/${tank.id}/care`, { type: 'nuke' })).statusCode,
    ).toBe(400);
  });
});

describe('overfeeding', () => {
  it('poisons the tank with ammonia and kills a fish that never gets a water change', async () => {
    const h = await createHarness();
    try {
      const cookie = await signedIn(h);
      const tank = await createTank(h, cookie);
      let current = await addFish(h, cookie, tank.id);
      for (let day = 0; day < 10 && current.fish[0]?.status === 'alive'; day++) {
        for (let i = 0; i < 3; i++) {
          const res = await call(h, cookie, 'POST', `/api/tanks/${tank.id}/care`, {
            type: 'feed',
            food: 'flakes',
            portion: 5,
          });
          expect(res.statusCode).toBe(200);
        }
        await advance(h, DAY);
        current = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
      }
      expect(current.fish[0]).toMatchObject({ status: 'dead', cause: 'ammonia' });
      expect(current.away?.deaths[0]?.cause).toBe('ammonia');
    } finally {
      await h.close();
    }
  });
});

describe('hooks and error codes', () => {
  it('does not expose the time-travel hook unless test hooks are enabled', async () => {
    const h = await createHarness({ testHooks: false });
    try {
      const res = await advance(h, 60);
      expect(res.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });

  it('maps oversized and unsupported bodies to their own codes', async () => {
    const h = await createHarness();
    try {
      const cookie = await signedIn(h);
      const unsupported = await h.app.inject({
        method: 'POST',
        url: '/api/tanks',
        headers: { 'content-type': 'text/plain', origin: APP_ORIGIN, cookie },
        payload: 'hello',
      });
      expect(unsupported.statusCode).toBe(415);
      expect(apiErrorSchema.parse(unsupported.json()).error.code).toBe('unsupported_media_type');
      const huge = await h.app.inject({
        method: 'POST',
        url: '/api/tanks',
        headers: { ...jsonHeaders, cookie },
        payload: JSON.stringify({ name: 'x'.repeat(2_000_000), biome: 'reef' }),
      });
      expect(huge.statusCode).toBe(413);
      expect(apiErrorSchema.parse(huge.json()).error.code).toBe('payload_too_large');
    } finally {
      await h.close();
    }
  });
});

describe('PATCH decor layout validation', () => {
  let h: Harness;
  let cookie: string;
  beforeEach(async () => {
    h = await createHarness();
    cookie = await signedIn(h);
  });
  afterEach(() => h.close());

  type Vec = [number, number, number];
  const piece = (assetId: string, position: Vec = [0, 0.05, 0]) => ({ assetId, position });

  function patch(tankId: string, decorLayout: unknown[]) {
    return call(h, cookie, 'PATCH', `/api/tanks/${tankId}`, { decorLayout });
  }

  function expectRejected(res: LightMyRequestResponse, path: (string | number)[]) {
    expect(res.statusCode).toBe(400);
    const body = apiErrorSchema.parse(res.json());
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.issues?.map((i) => i.path)).toContainEqual(path);
  }

  it('accepts a valid layout in each biome and stores it', async () => {
    const fresh = await createTank(h, cookie);
    const reef = await createTank(h, cookie, 'reef');
    const reefLayout = [piece('reef-arch'), piece('euphyllia-torch-8'), piece('brain-coral')];
    const freshRes = await patch(fresh.id, [piece('driftwood-branch'), piece('vacation-feeder')]);
    expect(freshRes.statusCode).toBe(200);
    expect((await patch(reef.id, reefLayout)).statusCode).toBe(200);
    const got = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${reef.id}`)).json());
    expect(got.decorLayout.map((i) => i.assetId)).toEqual(reefLayout.map((i) => i.assetId));
  });

  describe('tint seed', () => {
    const coral = { assetId: 'brain-coral', rotationY: 0.4, scale: 1 };
    const getLayout = async (id: string) =>
      tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${id}`)).json()).decorLayout;
    const storedLayout = async (id: string) => {
      const [row] = await h.database.db.select().from(schema.tanks).where(eq(schema.tanks.id, id));
      return decorLayoutSchema.parse(row?.decorLayout);
    };

    it('assigns a seed on save and keeps it when the coral is moved or rotated', async () => {
      const reef = await createTank(h, cookie, 'reef');
      await patch(reef.id, [{ ...coral, position: [0, 0.05, 0] }]);
      const [saved] = await storedLayout(reef.id);
      expect(saved?.tintSeed).toBeTypeOf('number');

      const moved = await patch(reef.id, [
        { ...saved, position: [0.2, 0.05, 0.1], rotationY: 1.9 },
      ]);
      expect(moved.statusCode).toBe(200);
      const [after] = await getLayout(reef.id);
      expect(after?.tintSeed).toBe(saved?.tintSeed);
      expect(after?.position).toEqual([0.2, 0.05, 0.1]);
    });

    it('serves a placement-derived seed for rows stored without one, and persists it on save', async () => {
      const reef = await createTank(h, cookie, 'reef');
      await h.database.db
        .update(schema.tanks)
        .set({ decorLayout: [{ ...coral, position: [0.1, 0.05, 0.2] }] })
        .where(eq(schema.tanks.id, reef.id));
      const [legacy] = await getLayout(reef.id);
      expect(legacy?.tintSeed).toBe(legacyTintSeed({ position: [0.1, 0.05, 0.2], rotationY: 0.4 }));

      await patch(reef.id, [{ ...legacy, position: [-0.3, 0.05, 0] }]);
      expect((await storedLayout(reef.id))[0]?.tintSeed).toBe(legacy?.tintSeed);
    });

    it('stores a seedless piece with the seed of its saved placement', async () => {
      const reef = await createTank(h, cookie, 'reef');
      await patch(reef.id, [
        { ...coral, position: [0, 0.05, 0] },
        { ...coral, position: [0.2, 0.05, 0] },
      ]);
      const layout = await storedLayout(reef.id);
      expect(layout).toHaveLength(2);
      expect(layout.map((i) => i.tintSeed)).toEqual(layout.map((i) => legacyTintSeed(i)));
      expect(layout[0]?.tintSeed).not.toBe(layout[1]?.tintSeed);
    });
  });

  it('rejects an asset id that is in no catalog', async () => {
    const tank = await createTank(h, cookie);
    expectRejected(await patch(tank.id, [piece('boulder-01'), piece('nope')]), [
      'decorLayout',
      1,
      'assetId',
    ]);
  });

  it('rejects an asset id from the other biome', async () => {
    const fresh = await createTank(h, cookie);
    const reef = await createTank(h, cookie, 'reef');
    expectRejected(await patch(fresh.id, [piece('brain-coral')]), ['decorLayout', 0, 'assetId']);
    expectRejected(await patch(reef.id, [piece('java-fern')]), ['decorLayout', 0, 'assetId']);
  });

  it('rejects a second vacation feeder', async () => {
    const tank = await createTank(h, cookie);
    expectRejected(
      await patch(tank.id, [piece('vacation-feeder'), piece('vacation-feeder', [0.1, 0, 0])]),
      ['decorLayout', 1, 'assetId'],
    );
  });

  it.each<[string, Vec]>([
    ['+x', [0.6, 0.05, 0]],
    ['-x', [-0.6, 0.05, 0]],
    ['+z', [0, 0.05, 0.26]],
    ['-z', [0, 0.05, -0.26]],
    ['y above the rim', [0, 0.51, 0]],
    ['y below the glass', [0, -0.01, 0]],
  ])('rejects a position outside the tank on %s', async (_axis, position) => {
    const tank = await createTank(h, cookie);
    expectRejected(await patch(tank.id, [piece('boulder-01', position)]), [
      'decorLayout',
      0,
      'position',
    ]);
  });

  it('accepts positions exactly on the interior boundary', async () => {
    const tank = await createTank(h, cookie);
    const { x, z, yMax } = decorPositionLimits();
    const res = await patch(tank.id, [
      piece('boulder-01', [x, 0, z]),
      piece('boulder-01', [-x, yMax, -z]),
    ]);
    expect(res.statusCode).toBe(200);
  });

  describe('edited flag', () => {
    const fetchTank = async (id: string) =>
      tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${id}`)).json());
    const storedColumn = async (id: string) => {
      const [row] = await h.database.db.select().from(schema.tanks).where(eq(schema.tanks.id, id));
      return row?.decorLayout;
    };

    it('reports a new tank as never edited and stores null', async () => {
      const tank = await createTank(h, cookie);
      expect(tank.decorEdited).toBe(false);
      expect(tank.decorLayout).toEqual([]);
      expect(await storedColumn(tank.id)).toBeNull();
    });

    it('tells an emptied layout from a never-edited one', async () => {
      const tank = await createTank(h, cookie);
      await patch(tank.id, [piece('driftwood-branch')]);
      expect((await fetchTank(tank.id)).decorEdited).toBe(true);
      const emptied = tankSchema.parse((await patch(tank.id, [])).json());
      expect(emptied.decorEdited).toBe(true);
      expect(emptied.decorLayout).toEqual([]);
      expect(await storedColumn(tank.id)).toEqual([]);
      expect(await fetchTank(tank.id)).toMatchObject({ decorEdited: true, decorLayout: [] });
    });

    it('stays never edited after a rename', async () => {
      const tank = await createTank(h, cookie);
      await call(h, cookie, 'PATCH', `/api/tanks/${tank.id}`, { name: 'Renamed' });
      expect((await fetchTank(tank.id)).decorEdited).toBe(false);
    });

    it('treats a null column as no vacation feeder', async () => {
      const never = await createTank(h, cookie);
      const emptied = await createTank(h, cookie);
      const fed = await createTank(h, cookie);
      expect(await storedColumn(never.id)).toBeNull();
      await patch(emptied.id, []);
      await patch(fed.id, [piece('vacation-feeder')]);
      for (const t of [never, emptied, fed]) await addFish(h, cookie, t.id);
      await advance(h, 2 * DAY);
      const hungerOf = async (id: string) => (await fetchTank(id)).fish[0]?.hunger ?? 0;
      const neverHunger = await hungerOf(never.id);
      expect(neverHunger).toBeGreaterThan(0.1);
      expect(neverHunger).toBeCloseTo(await hungerOf(emptied.id), 6);
      expect(neverHunger).toBeCloseTo((await hungerOf(fed.id)) * 2, 2);
    });
  });

  it('keeps old junk readable but refuses to save it again', async () => {
    const tank = await createTank(h, cookie);
    const junk = [piece('legacy-thing', [3, 0, 3]), piece('vacation-feeder')];
    await h.database.db
      .update(schema.tanks)
      .set({ decorLayout: junk.map((j) => ({ ...j, rotationY: 0, scale: 1 })) })
      .where(eq(schema.tanks.id, tank.id));
    const got = await call(h, cookie, 'GET', `/api/tanks/${tank.id}`);
    expect(got.statusCode).toBe(200);
    expect(tankSchema.parse(got.json()).decorLayout).toHaveLength(2);
    const renamed = await call(h, cookie, 'PATCH', `/api/tanks/${tank.id}`, { name: 'Renamed' });
    expect(renamed.statusCode).toBe(200);
    expectRejected(await patch(tank.id, junk), ['decorLayout', 0, 'assetId']);
  });
});

describe('tank sizes, quarantine and sharing', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const create = (cookie: string, body: object) => call(h, cookie, 'POST', '/api/tanks', body);

  it('agrees with the sim on the standard tank cap', () => {
    expect(TANK_SIZES.standard.maxAnimals).toBe(MAX_FISH_PER_TANK);
  });

  it('creates standard tanks by default and every other size on request', async () => {
    const cookie = await signedIn(h);
    const standard = tankSchema.parse((await create(cookie, { name: 'A', biome: 'reef' })).json());
    expect(standard).toMatchObject({ size: 'standard', quarantine: false, shareToken: null });
    expect(standard.chemistry).toEqual(newTankChemistry('reef'));
    for (const size of ['nano30', 'std200', 'long300'] as const) {
      const res = await create(cookie, { name: size, biome: 'freshwater', size });
      expect(res.statusCode).toBe(201);
      expect(tankSchema.parse(res.json()).size).toBe(size);
    }
  });

  it('refuses a non-nano quarantine tank, an unknown size and an unplayable biome', async () => {
    const cookie = await signedIn(h);
    for (const body of [
      { name: 'Q', biome: 'freshwater', quarantine: true },
      { name: 'Q', biome: 'freshwater', size: 'huge' },
      { name: 'Q', biome: 'mangrove' },
    ]) {
      expect((await create(cookie, body)).statusCode).toBe(400);
    }
  });

  it('does not count the quarantine tank towards the six', async () => {
    const cookie = await signedIn(h);
    await create(cookie, { name: 'Q', biome: 'freshwater', size: 'nano30', quarantine: true });
    for (let i = 0; i < 6; i++) {
      expect((await create(cookie, { name: `T${i}`, biome: 'freshwater' })).statusCode).toBe(201);
    }
  });

  it('caps a nano tank at 12 animals and a standard tank at its own limit', async () => {
    const cookie = await signedIn(h);
    const nano = tankSchema.parse(
      (await create(cookie, { name: 'Nano', biome: 'freshwater', size: 'nano30' })).json(),
    );
    for (let i = 0; i < 12; i++) await addFish(h, cookie, nano.id, 'neon-tetra', `N${i}`);
    const res = await call(h, cookie, 'POST', `/api/tanks/${nano.id}/fish`, {
      species: 'neon-tetra',
      name: 'Thirteen',
    });
    expect(res.statusCode).toBe(409);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('conflict');
  });

  it('keeps every animal in an over-cap tank and only blocks additions', async () => {
    const cookie = await signedIn(h);
    const nano = tankSchema.parse(
      (await create(cookie, { name: 'Nano', biome: 'freshwater', size: 'nano30' })).json(),
    );
    for (let i = 0; i < 12; i++) await addFish(h, cookie, nano.id, 'neon-tetra', `N${i}`);
    const [row] = await h.database.db
      .select()
      .from(schema.fish)
      .where(eq(schema.fish.tankId, nano.id))
      .limit(1);
    if (!row) throw new Error('no fish');
    await h.database.db.insert(schema.fish).values({
      tankId: nano.id,
      species: row.species,
      name: 'Extra 1',
      size: row.size,
      sex: row.sex,
    });
    await h.database.db.insert(schema.fish).values({
      tankId: nano.id,
      species: row.species,
      name: 'Extra 2',
      size: row.size,
      sex: row.sex,
    });
    const reread = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${nano.id}`)).json());
    expect(reread.fish).toHaveLength(14);
    const blocked = await call(h, cookie, 'POST', `/api/tanks/${nano.id}/fish`, {
      species: 'neon-tetra',
      name: 'Nope',
    });
    expect(blocked.statusCode).toBe(409);
  });

  describe('share token', () => {
    it('is null while private, then created, rotated and revoked by the owner', async () => {
      const cookie = await signedIn(h);
      const tank = await createTank(h, cookie);
      expect(tank.shareToken).toBeNull();

      const created = await call(h, cookie, 'POST', `/api/tanks/${tank.id}/share`);
      expect(created.statusCode).toBe(200);
      const first = shareTokenSchema.parse(tankSchema.parse(created.json()).shareToken);

      const rotated = await call(h, cookie, 'POST', `/api/tanks/${tank.id}/share/rotate`);
      const second = shareTokenSchema.parse(tankSchema.parse(rotated.json()).shareToken);
      expect(second).not.toBe(first);

      const read = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
      expect(read.shareToken).toBe(second);

      const revoked = await call(h, cookie, 'DELETE', `/api/tanks/${tank.id}/share`);
      expect(revoked.statusCode).toBe(200);
      expect(tankSchema.parse(revoked.json()).shareToken).toBeNull();
      const [row] = await h.database.db
        .select()
        .from(schema.tanks)
        .where(eq(schema.tanks.id, tank.id));
      expect(row?.shareToken).toBeNull();
    });

    it('keeps the token when POST is repeated, and rotates it only on request', async () => {
      const cookie = await signedIn(h);
      const tank = await createTank(h, cookie);
      const tokenOf = (res: LightMyRequestResponse) =>
        shareTokenSchema.parse(tankSchema.parse(res.json()).shareToken);
      const first = tokenOf(await call(h, cookie, 'POST', `/api/tanks/${tank.id}/share`));
      const again = tokenOf(await call(h, cookie, 'POST', `/api/tanks/${tank.id}/share`));
      expect(again).toBe(first);
      const rotated = tokenOf(await call(h, cookie, 'POST', `/api/tanks/${tank.id}/share/rotate`));
      expect(rotated).not.toBe(first);
      expect(tokenOf(await call(h, cookie, 'GET', `/api/tanks/${tank.id}`))).toBe(rotated);
      const other = await signedIn(h);
      expect((await call(h, other, 'POST', `/api/tanks/${tank.id}/share/rotate`)).statusCode).toBe(
        404,
      );
    });

    it('is at least 128 bits and unique per tank', async () => {
      const cookie = await signedIn(h);
      const a = await createTank(h, cookie);
      const b = await createTank(h, cookie);
      const tokenOf = async (id: string) =>
        shareTokenSchema.parse(
          tankSchema.parse((await call(h, cookie, 'POST', `/api/tanks/${id}/share`)).json())
            .shareToken,
        );
      const [ta, tb] = [await tokenOf(a.id), await tokenOf(b.id)];
      expect(ta).not.toBe(tb);
      expect(Buffer.from(ta, 'base64url').length).toBeGreaterThanOrEqual(16);
    });

    it('is owner-only and needs a session', async () => {
      const owner = await signedIn(h);
      const other = await signedIn(h);
      const tank = await createTank(h, owner);
      expect((await call(h, other, 'POST', `/api/tanks/${tank.id}/share`)).statusCode).toBe(404);
      expect((await call(h, other, 'DELETE', `/api/tanks/${tank.id}/share`)).statusCode).toBe(404);
      const anon = await h.app.inject({
        method: 'POST',
        url: `/api/tanks/${tank.id}/share`,
        headers: jsonHeaders,
      });
      expect(anon.statusCode).toBe(401);
    });
  });

  it('stores disease and nitrite as causes of death', async () => {
    const cookie = await signedIn(h);
    const tank = await createTank(h, cookie);
    for (const cause of ['disease', 'nitrite'] as const) {
      await h.database.db.insert(schema.memorials).values({
        tankId: tank.id,
        fishName: cause,
        species: 'neon-tetra',
        bornAt: new Date(),
        diedAt: new Date(),
        cause,
      });
    }
    const read = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
    expect(read.memorials.map((m) => m.cause).sort()).toEqual(['disease', 'nitrite']);
  });
});

describe('share throttle', () => {
  it('shares the care bucket and answers 429 past it', async () => {
    const h = await createHarness({
      careLimits: { ...DEFAULT_CARE_LIMITS, care: { max: 2, windowMs: 60_000 } },
    });
    try {
      const cookie = await signedIn(h);
      const tank = await createTank(h, cookie);
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        codes.push((await call(h, cookie, 'POST', `/api/tanks/${tank.id}/share`)).statusCode);
      }
      expect(codes).toEqual([200, 200, 429]);
    } finally {
      await h.close();
    }
  });
});
