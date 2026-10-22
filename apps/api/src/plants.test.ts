import { randomUUID } from 'node:crypto';
import { apiErrorSchema, tankSchema, type Plant, type Tank } from '@aquarium/shared';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from './db/index.ts';
import { APP_ORIGIN, createHarness, topUp, type Harness } from './test-harness.ts';
import { DEFAULT_CARE_LIMITS } from './tanks.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
const DAY_MS = 86_400_000;
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

interface Account {
  cookie: string;
  userId: string;
}

async function account(h: Harness): Promise<Account> {
  const email = `t42-${Date.now()}-${counter++}@bas.lu`;
  const signedUp = await h.app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: jsonHeaders,
    payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/verify-email' },
  });
  const mail = h.outbox.findLast((m) => m.to === email);
  const link = /https?:\/\/\S+verify-email\?\S+/.exec(mail?.text ?? '')?.[0];
  if (!link) throw new Error('no verification link');
  const url = new URL(link);
  const cookie = cookieOf(
    await h.app.inject({
      method: 'GET',
      url: url.pathname + url.search,
      headers: { cookie: cookieOf(signedUp) },
    }),
  );
  if (!cookie) throw new Error('verification did not sign in');
  const [user] = await h.database.db.select().from(schema.user).where(eq(schema.user.email, email));
  if (!user) throw new Error('user missing');
  return { cookie, userId: user.id };
}

const call = (
  h: Harness,
  who: Account,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: object,
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie: who.cookie },
    ...(payload ? { payload } : {}),
  });

const errorOf = (res: LightMyRequestResponse) => apiErrorSchema.parse(res.json()).error;
const tankOf = (res: LightMyRequestResponse): Tank => {
  expect(res.statusCode).toBe(200);
  return tankSchema.parse(res.json());
};

const layoutItem = (assetId: string, tintSeed: number, x = 0) => ({
  assetId,
  position: [x, 0.1, 0],
  rotationY: 0,
  scale: 1,
  tintSeed,
});

async function makeTank(
  h: Harness,
  who: Account,
  opts: { layout?: object[] | null; nitrate?: number } = {},
): Promise<string> {
  await topUp(h);
  await h.database.db.delete(schema.tanks).where(eq(schema.tanks.ownerId, who.userId));
  const res = await call(h, who, 'POST', '/api/tanks', {
    name: 'Garden',
    biome: 'freshwater',
    idempotencyKey: randomUUID(),
  });
  expect(res.statusCode).toBe(201);
  const id = tankSchema.parse(res.json()).id;
  await h.database.db
    .update(schema.tanks)
    .set({
      decorLayout: opts.layout === undefined ? [layoutItem('universal-plant', 11)] : opts.layout,
      water: { ammonia: 0, nitrate: opts.nitrate ?? 40, algae: 0, uneatenFood: 0 },
      lastTickAt: new Date(h.clock.now()),
    })
    .where(eq(schema.tanks.id, id));
  return id;
}

const trim = (h: Harness, who: Account, tankId: string, body: object) =>
  call(h, who, 'POST', `/api/tanks/${tankId}/plants/trim`, body);
const plantOf = (tank: Tank, key: string): Plant => {
  const plant = tank.plants?.find((p) => p.key === key);
  if (!plant) throw new Error(`no plant ${key}`);
  return plant;
};
const grow = async (h: Harness, who: Account, tankId: string, days: number): Promise<Tank> => {
  h.clock.advance(days * DAY_MS);
  return tankOf(await call(h, who, 'GET', `/api/tanks/${tankId}`));
};

describe('growing plants', () => {
  let h: Harness;
  let alice: Account;
  beforeAll(async () => {
    h = await createHarness();
    alice = await account(h);
  });
  afterAll(() => h.close());

  it('grows layout plants over an absence and takes up nitrate', async () => {
    const tankId = await makeTank(h, alice);
    const before = tankOf(await call(h, alice, 'GET', `/api/tanks/${tankId}`));
    expect(plantOf(before, 's11').size).toBe(1);
    const after = await grow(h, alice, tankId, 7);
    const plant = plantOf(after, 's11');
    expect(plant).toMatchObject({ assetId: 'universal-plant', tintSeed: 11, parentKey: null });
    expect(plant.size).toBeGreaterThan(1);
    expect(plant.size).toBeLessThanOrEqual(plant.maxSize);
    expect(after.water.nitrate).toBeLessThan(40);
    const [row] = await h.database.db
      .select()
      .from(schema.tanks)
      .where(eq(schema.tanks.id, tankId));
    expect(row?.plants).toMatchObject([{ key: 's11', size: plant.size }]);
  });

  it('does not grow in a tank with no nitrate', async () => {
    const tankId = await makeTank(h, alice, { nitrate: 0 });
    const after = await grow(h, alice, tankId, 7);
    expect(plantOf(after, 's11').size).toBe(1);
    expect(after.water.nitrate).toBe(0);
  });

  it('does not grow with the lamp removed', async () => {
    const tankId = await makeTank(h, alice);
    await h.database.db
      .update(schema.tanks)
      .set({
        equipment: {
          filter: { tier: 1 },
          heater: { tier: 1 },
          light: { tier: 0, intensity: 0.8, onHour: 8, offHour: 20 },
          co2: { tier: 0 },
          waveMaker: { tier: 0 },
        },
      })
      .where(eq(schema.tanks.id, tankId));
    const after = await grow(h, alice, tankId, 7);
    expect(plantOf(after, 's11').size).toBe(1);
  });

  it('shows the preset plants of a tank whose layout was never edited', async () => {
    const tankId = await makeTank(h, alice, { layout: null });
    const tank = tankOf(await call(h, alice, 'GET', `/api/tanks/${tankId}`));
    expect(tank.decorEdited).toBe(false);
    expect(tank.plants?.map((p) => p.assetId)).toEqual(['java-fern', 'java-fern']);
  });

  it('puts a plant added to the layout in at size 1 and drops one taken out', async () => {
    const tankId = await makeTank(h, alice, {
      layout: [layoutItem('java-fern', 11), layoutItem('java-fern', 12, 0.2)],
      nitrate: 400,
    });
    const grown = await grow(h, alice, tankId, 10);
    expect(plantOf(grown, 's12').size).toBeGreaterThan(1);
    const swapped = tankOf(
      await call(h, alice, 'PATCH', `/api/tanks/${tankId}`, {
        decorLayout: [layoutItem('java-fern', 11), layoutItem('java-fern', 13, 0.3)],
      }),
    );
    expect(plantOf(swapped, 's11').size).toBeCloseTo(plantOf(grown, 's11').size, 2);
    expect(plantOf(swapped, 's13').size).toBe(1);
    expect(swapped.plants?.map((p) => p.key)).toEqual(['s11', 's13']);
    const [row] = await h.database.db
      .select()
      .from(schema.tanks)
      .where(eq(schema.tanks.id, tankId));
    expect(row?.plants).toMatchObject([{ key: 's11' }, { key: 's13' }]);
  });

  it('spreads runner plants to offsets inside the glass', async () => {
    const tankId = await makeTank(h, alice, {
      layout: [layoutItem('vallisneria', 21, -0.3), layoutItem('vallisneria', 22, 0.3)],
      nitrate: 1000,
    });
    await h.database.db
      .update(schema.tanks)
      .set({
        equipment: {
          filter: { tier: 1 },
          heater: { tier: 1 },
          light: { tier: 3, intensity: 1, onHour: 8, offHour: 20 },
          co2: { tier: 0 },
          waveMaker: { tier: 0 },
        },
      })
      .where(eq(schema.tanks.id, tankId));
    const after = await grow(h, alice, tankId, 40);
    const offsets = (after.plants ?? []).filter((p) => p.parentKey !== null);
    expect(offsets.length).toBeGreaterThan(2);
    for (const o of offsets) {
      const [x, z] = o.position ?? [99, 99];
      expect(Math.abs(x)).toBeLessThan(0.6);
      expect(Math.abs(z)).toBeLessThan(0.25);
      expect(o.tintSeed).toBeNull();
    }
  });

  const lit = {
    filter: { tier: 1 },
    heater: { tier: 1 },
    light: { tier: 3, intensity: 1, onHour: 8, offHour: 20 },
    co2: { tier: 0 },
    waveMaker: { tier: 0 },
  };

  it('moves the offsets with their parent when the parent is moved', async () => {
    const tankId = await makeTank(h, alice, {
      layout: [layoutItem('vallisneria', 31, -0.3)],
      nitrate: 1000,
    });
    await h.database.db
      .update(schema.tanks)
      .set({ equipment: lit })
      .where(eq(schema.tanks.id, tankId));
    const grown = await grow(h, alice, tankId, 30);
    const before = (grown.plants ?? []).filter((p) => p.parentKey === 's31');
    expect(before.length).toBeGreaterThan(0);
    const moved = tankOf(
      await call(h, alice, 'PATCH', `/api/tanks/${tankId}`, {
        decorLayout: [layoutItem('vallisneria', 31, 0.1)],
      }),
    );
    const after = (moved.plants ?? []).filter((p) => p.parentKey === 's31');
    expect(after.map((p) => p.key)).toEqual(before.map((p) => p.key));
    for (const [i, offset] of after.entries()) {
      expect(offset.position?.[0]).toBeCloseTo((before[i]?.position?.[0] ?? NaN) + 0.4, 9);
      expect(offset.position?.[1]).toBeCloseTo(before[i]?.position?.[1] ?? NaN, 9);
    }
  });

  it('keeps offsets out of a rock', async () => {
    const rock = { ...layoutItem('boulder-01', 32, 0.12), rotationY: 0.6 };
    const tankId = await makeTank(h, alice, {
      layout: [layoutItem('vallisneria', 31, 0), rock],
      nitrate: 1000,
    });
    await h.database.db
      .update(schema.tanks)
      .set({ equipment: lit })
      .where(eq(schema.tanks.id, tankId));
    const grown = await grow(h, alice, tankId, 60);
    const offsets = (grown.plants ?? []).filter((p) => p.parentKey !== null);
    expect(offsets.length).toBeGreaterThan(2);
    for (const o of offsets) {
      const [x, z] = o.position ?? [NaN, NaN];
      const dx = x - 0.12;
      const lx = dx * Math.cos(0.6) - z * Math.sin(0.6);
      const lz = dx * Math.sin(0.6) + z * Math.cos(0.6);
      expect(Math.abs(lx) <= 0.12163 && Math.abs(lz) <= 0.175).toBe(false);
    }
  });

  describe('tint seeds on save', () => {
    const save = (tankId: string, decorLayout: object[]) =>
      call(h, alice, 'PATCH', `/api/tanks/${tankId}`, { decorLayout });
    const seedsOf = (tank: Tank) => tank.decorLayout.map((item) => item.tintSeed);

    it('gives a repeated seed a new one instead of rejecting the save', async () => {
      const tankId = await makeTank(h, alice, {
        layout: [
          layoutItem('java-fern', 41),
          layoutItem('java-fern', 46, 0.2),
          layoutItem('java-fern', 47, 0.3),
        ],
      });
      const saved = tankOf(
        await save(tankId, [
          layoutItem('java-fern', 41),
          layoutItem('java-fern', 41, 0.2),
          layoutItem('java-fern', 41, 0.3),
        ]),
      );
      const seeds = seedsOf(saved);
      expect(seeds[0]).toBe(41);
      expect(new Set(seeds).size).toBe(3);
      expect(new Set(saved.plants?.map((p) => p.key)).size).toBe(3);
    });

    it('keeps the seeds, and the repeats, of a layout that was already saved', async () => {
      const tankId = await makeTank(h, alice, {
        layout: [
          layoutItem('java-fern', 42),
          layoutItem('java-fern', 42, 0.2),
          layoutItem('java-fern', 45, 0.3),
        ],
      });
      const saved = tankOf(
        await save(tankId, [
          layoutItem('java-fern', 42),
          layoutItem('java-fern', 42, 0.2),
          layoutItem('java-fern', 43, 0.3),
        ]),
      );
      expect(seedsOf(saved)).toEqual([42, 42, 43]);
      expect(saved.plants?.map((p) => p.key)).toEqual(['s42', 's42-2', 's43']);
    });

    it('is stable: saving the result again changes nothing', async () => {
      const tankId = await makeTank(h, alice, {
        layout: [layoutItem('java-fern', 44), layoutItem('java-fern', 48, 0.2)],
      });
      const first = tankOf(
        await save(tankId, [layoutItem('java-fern', 44), layoutItem('java-fern', 44, 0.2)]),
      );
      const again = tankOf(await save(tankId, first.decorLayout));
      expect(seedsOf(again)).toEqual(seedsOf(first));
    });
  });
});

describe('trimming a plant', () => {
  let h: Harness;
  let alice: Account;
  let mallory: Account;
  beforeAll(async () => {
    h = await createHarness({
      careLimits: { ...DEFAULT_CARE_LIMITS, care: { max: 12, windowMs: 60_000 } },
    });
    alice = await account(h);
    mallory = await account(h);
  });
  afterAll(() => h.close());

  async function grownTank(): Promise<{ tankId: string; size: number }> {
    const tankId = await makeTank(h, alice, { nitrate: 400 });
    const tank = await grow(h, alice, tankId, 14);
    return { tankId, size: plantOf(tank, 's11').size };
  }

  it('cuts the plant back, leaves the water alone, and the plant grows again', async () => {
    const { tankId, size } = await grownTank();
    expect(size).toBeGreaterThan(1.5);
    const res = await trim(h, alice, tankId, {
      plantKey: 's11',
      size: 0.6,
      idempotencyKey: randomUUID(),
    });
    const tank = tankOf(res);
    expect(plantOf(tank, 's11').size).toBeCloseTo(0.6, 3);
    const [row] = await h.database.db
      .select()
      .from(schema.tanks)
      .where(eq(schema.tanks.id, tankId));
    expect(row?.water).toMatchObject({ nitrate: tank.water.nitrate });
    const later = await grow(h, alice, tankId, 3);
    expect(plantOf(later, 's11').size).toBeGreaterThan(0.6);
  });

  it('refuses a size below the species minimum', async () => {
    const { tankId, size } = await grownTank();
    const res = await trim(h, alice, tankId, {
      plantKey: 's11',
      size: 0.39,
      idempotencyKey: randomUUID(),
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toMatchObject({ code: 'validation_failed' });
    const [row] = await h.database.db
      .select()
      .from(schema.tanks)
      .where(eq(schema.tanks.id, tankId));
    expect(row?.plants).toMatchObject([{ key: 's11', size: expect.closeTo(size, 1) }]);
  });

  it('allows trimming exactly to the minimum', async () => {
    const { tankId } = await grownTank();
    const res = await trim(h, alice, tankId, {
      plantKey: 's11',
      size: 0.4,
      idempotencyKey: randomUUID(),
    });
    expect(plantOf(tankOf(res), 's11').size).toBeCloseTo(0.4, 6);
  });

  it('refuses to trim a plant that is not that big', async () => {
    const { tankId } = await grownTank();
    const res = await trim(h, alice, tankId, {
      plantKey: 's11',
      size: 2.5,
      idempotencyKey: randomUUID(),
    });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).reason).toBe('plant_not_grown');
  });

  it('answers 404 for an unknown plant', async () => {
    const { tankId } = await grownTank();
    const res = await trim(h, alice, tankId, {
      plantKey: 's999',
      size: 0.6,
      idempotencyKey: randomUUID(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("answers 404 for another user's tank and leaves the plant alone", async () => {
    const { tankId } = await grownTank();
    const res = await trim(h, mallory, tankId, {
      plantKey: 's11',
      size: 0.6,
      idempotencyKey: randomUUID(),
    });
    expect(res.statusCode).toBe(404);
    const [row] = await h.database.db
      .select()
      .from(schema.tanks)
      .where(eq(schema.tanks.id, tankId));
    expect(row?.plants).toMatchObject([{ key: 's11', size: expect.not.closeTo(0.6, 2) }]);
  });

  it('needs a session', async () => {
    const { tankId } = await grownTank();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/tanks/${tankId}/plants/trim`,
      headers: jsonHeaders,
      payload: { plantKey: 's11', size: 0.6, idempotencyKey: randomUUID() },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a body without a key, with extra fields, or with a negative size', async () => {
    const { tankId } = await grownTank();
    for (const body of [
      { plantKey: 's11', size: 0.6 },
      { plantKey: 's11', size: 0.6, idempotencyKey: randomUUID(), extra: 1 },
      { plantKey: 's11', size: -1, idempotencyKey: randomUUID() },
      { plantKey: 's11', size: 0.6, idempotencyKey: 'short' },
    ]) {
      expect((await trim(h, alice, tankId, body)).statusCode).toBe(400);
    }
  });

  it('replays a retry with the same key instead of trimming again', async () => {
    const { tankId } = await grownTank();
    const body = { plantKey: 's11', size: 0.8, idempotencyKey: randomUUID() };
    const first = tankOf(await trim(h, alice, tankId, body));
    const grown = await grow(h, alice, tankId, 2);
    expect(plantOf(grown, 's11').size).toBeGreaterThan(plantOf(first, 's11').size);
    const retry = await trim(h, alice, tankId, body);
    expect(retry.statusCode).toBe(200);
    expect(plantOf(tankOf(retry), 's11').size).toBeCloseTo(plantOf(grown, 's11').size, 2);
  });

  it('refuses a key that was used for another plant or size', async () => {
    const { tankId } = await grownTank();
    const idempotencyKey = randomUUID();
    expect(
      (await trim(h, alice, tankId, { plantKey: 's11', size: 0.8, idempotencyKey })).statusCode,
    ).toBe(200);
    const other = await trim(h, alice, tankId, { plantKey: 's11', size: 0.5, idempotencyKey });
    expect(other.statusCode).toBe(409);
    expect(errorOf(other).reason).toBe('key_reused');
  });

  it('remembers only the last 16 keys', async () => {
    const bigHarness = await createHarness({
      careLimits: { ...DEFAULT_CARE_LIMITS, care: { max: 1000, windowMs: 60_000 } },
    });
    try {
      const who = await account(bigHarness);
      const id = await makeTank(bigHarness, who, { nitrate: 100_000 });
      await grow(bigHarness, who, id, 14);
      const keys: string[] = [];
      for (let i = 0; i < 17; i++) {
        keys.push(randomUUID());
        const res = await trim(bigHarness, who, id, {
          plantKey: 's11',
          size: 1.9 - i * 0.01,
          idempotencyKey: keys[i],
        });
        expect(res.statusCode).toBe(200);
      }
      const [row] = await bigHarness.database.db
        .select()
        .from(schema.tanks)
        .where(eq(schema.tanks.id, id));
      expect(row?.plantTrimKeys).toHaveLength(16);
    } finally {
      await bigHarness.close();
    }
    // 17 sequential requests on a fresh harness exceed the default 5s under load
  }, 30_000);

  it('is rate limited', async () => {
    const limited = await createHarness({
      careLimits: { ...DEFAULT_CARE_LIMITS, care: { max: 2, windowMs: 60_000 } },
    });
    try {
      const who = await account(limited);
      const id = await makeTank(limited, who);
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        codes.push(
          (
            await trim(limited, who, id, {
              plantKey: 's11',
              size: 0.6,
              idempotencyKey: randomUUID(),
            })
          ).statusCode,
        );
      }
      expect(codes.at(-1)).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it('does not count retries against the care limit', async () => {
    const limited = await createHarness({
      careLimits: { ...DEFAULT_CARE_LIMITS, care: { max: 2, windowMs: 60_000 } },
    });
    try {
      const who = await account(limited);
      const id = await makeTank(limited, who);
      const body = { plantKey: 's11', size: 0.6, idempotencyKey: randomUUID() };
      for (let i = 0; i < 5; i++) {
        expect((await trim(limited, who, id, body)).statusCode).toBe(200);
      }
      const fresh = { plantKey: 's11', size: 0.5, idempotencyKey: randomUUID() };
      expect((await trim(limited, who, id, fresh)).statusCode).toBe(200);
      const over = { plantKey: 's11', size: 0.45, idempotencyKey: randomUUID() };
      expect((await trim(limited, who, id, over)).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
