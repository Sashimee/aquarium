import { apiErrorSchema, speciesListSchema, tankListSchema, tankSchema } from '@aquarium/shared';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from './db/index.ts';
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
    payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/' },
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

  it('limits tanks per user', async () => {
    const cookie = await signedIn(h);
    for (let i = 0; i < 5; i++) await createTank(h, cookie);
    const res = await call(h, cookie, 'POST', '/api/tanks', { name: 'Six', biome: 'reef' });
    expect(res.statusCode).toBe(409);
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
