import { randomUUID } from 'node:crypto';
import {
  apiErrorSchema,
  coralSpeciesId,
  fitPresetItem,
  legacyTintSeed,
  tankSchema,
  type TankSize,
  type Coral,
  type Equipment,
  type Tank,
} from '@aquarium/shared';
import { layoutPlantKeys } from '@aquarium/sim/lifecycle';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCoralTable } from './corals.ts';
import { loadPlantTable, substrateBounds } from './plants.ts';
import { loadPresets } from './presets.ts';
import { schema } from './db/index.ts';
import { APP_ORIGIN, createHarness, topUp, type Harness } from './test-harness.ts';
import { DEFAULT_CARE_LIMITS } from './tanks.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
const DAY_MS = 86_400_000;
const coralTable = loadCoralTable();
const plantTable = loadPlantTable();
const presets = loadPresets();
const { fragStartSize, maxFragsPerTank } = coralTable.params;
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

interface Account {
  cookie: string;
  userId: string;
}

async function account(h: Harness): Promise<Account> {
  const email = `t43-${Date.now()}-${counter++}@bas.lu`;
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

const reefEquipment = (light: { tier: number; intensity: number }): Equipment => ({
  filter: { tier: 1 },
  heater: { tier: 1 },
  light: { ...light, onHour: 8, offHour: 20 },
  co2: { tier: 0 },
  waveMaker: { tier: 3 },
});
const GOOD = reefEquipment({ tier: 2, intensity: 1 });

async function makeTank(
  h: Harness,
  who: Account,
  opts: {
    layout?: object[] | null;
    equipment?: Equipment;
    biome?: 'reef' | 'freshwater';
    size?: TankSize;
  } = {},
): Promise<string> {
  await topUp(h);
  await h.database.db.delete(schema.tanks).where(eq(schema.tanks.ownerId, who.userId));
  const res = await call(h, who, 'POST', '/api/tanks', {
    name: 'Reef',
    biome: opts.biome ?? 'reef',
    size: opts.size ?? 'standard',
    idempotencyKey: randomUUID(),
  });
  expect(res.statusCode).toBe(201);
  const id = tankSchema.parse(res.json()).id;
  await h.database.db
    .update(schema.tanks)
    .set({
      decorLayout: opts.layout === undefined ? [layoutItem('acropora-cytherea', 31)] : opts.layout,
      equipment: opts.equipment ?? GOOD,
      lastTickAt: new Date(h.clock.now()),
    })
    .where(eq(schema.tanks.id, id));
  return id;
}

const rowOf = async (h: Harness, tankId: string) => {
  const [row] = await h.database.db.select().from(schema.tanks).where(eq(schema.tanks.id, tankId));
  if (!row) throw new Error('no tank row');
  return row;
};
const setCorals = (h: Harness, tankId: string, corals: object[]) =>
  h.database.db
    .update(schema.tanks)
    .set({ corals, lastTickAt: new Date(h.clock.now()) })
    .where(eq(schema.tanks.id, tankId));
const stored = (key: string, size: number, bleach = 0, assetId = 'acropora-cytherea') => ({
  key,
  assetId,
  parentKey: null,
  position: [0, 0],
  size,
  bleach,
  spawned: 0,
});

const frag = (h: Harness, who: Account, tankId: string, body: object) =>
  call(h, who, 'POST', `/api/tanks/${tankId}/corals/frag`, body);
const coralOf = (tank: Tank, key: string): Coral => {
  const coral = tank.corals?.find((c) => c.key === key);
  if (!coral) throw new Error(`no coral ${key}`);
  return coral;
};
const wait = async (h: Harness, who: Account, tankId: string, days: number): Promise<Tank> => {
  h.clock.advance(days * DAY_MS);
  return tankOf(await call(h, who, 'GET', `/api/tanks/${tankId}`));
};
const minimum = coralTable.species.get('acropora-cytherea')?.fragMinSize ?? 0;

describe('coral growth and bleaching', () => {
  let h: Harness;
  let alice: Account;
  beforeAll(async () => {
    h = await createHarness();
    alice = await account(h);
  });
  afterAll(() => h.close());

  it('grows layout corals over an absence and stores them', async () => {
    const tankId = await makeTank(h, alice);
    const before = tankOf(await call(h, alice, 'GET', `/api/tanks/${tankId}`));
    expect(coralOf(before, 's31')).toMatchObject({ size: 1, bleach: 0, fragMinSize: minimum });
    const after = await wait(h, alice, tankId, 20);
    const coral = coralOf(after, 's31');
    expect(coral).toMatchObject({ assetId: 'acropora-cytherea', tintSeed: 31, parentKey: null });
    expect(coral.size).toBeGreaterThan(1.2);
    expect(coral.size).toBeLessThanOrEqual(coral.maxSize);
    expect(coral.bleach).toBeLessThan(0.01);
    expect((await rowOf(h, tankId)).corals).toMatchObject([{ key: 's31', size: coral.size }]);
  });

  it('does not grow with the lamp removed', async () => {
    const tankId = await makeTank(h, alice, {
      equipment: reefEquipment({ tier: 0, intensity: 1 }),
    });
    const after = await wait(h, alice, tankId, 20);
    expect(coralOf(after, 's31').size).toBe(1);
  });

  it('bleaches in too much light and recovers when it is turned down', async () => {
    const tankId = await makeTank(h, alice, {
      equipment: reefEquipment({ tier: 3, intensity: 1 }),
    });
    const bleached = coralOf(await wait(h, alice, tankId, 5), 's31');
    expect(bleached.bleach).toBeGreaterThan(0.9);
    expect(bleached.size).toBe(1);
    await h.database.db
      .update(schema.tanks)
      .set({ equipment: GOOD })
      .where(eq(schema.tanks.id, tankId));
    const recovering = coralOf(await wait(h, alice, tankId, 7), 's31');
    expect(recovering.bleach).toBeLessThan(bleached.bleach);
    expect(recovering.bleach).toBeGreaterThan(0.2);
    const recovered = coralOf(await wait(h, alice, tankId, 50), 's31');
    expect(recovered.bleach).toBeLessThan(0.05);
  });

  it('shows the preset corals of a tank whose layout was never edited', async () => {
    const tankId = await makeTank(h, alice, { layout: null });
    const tank = tankOf(await call(h, alice, 'GET', `/api/tanks/${tankId}`));
    expect(tank.decorEdited).toBe(false);
    expect(tank.corals?.length).toBeGreaterThan(0);
    expect(tank.corals?.every((c) => coralTable.species.has(coralSpeciesId(c.assetId)))).toBe(true);
  });

  it('has no corals in a freshwater tank', async () => {
    const tankId = await makeTank(h, alice, { biome: 'freshwater', layout: null });
    const tank = tankOf(await call(h, alice, 'GET', `/api/tanks/${tankId}`));
    expect(tank.corals).toEqual([]);
  });

  it('puts a coral added to the layout in at size 1 and drops one taken out', async () => {
    const tankId = await makeTank(h, alice, {
      layout: [layoutItem('acropora-cytherea', 31), layoutItem('brain-coral', 32, 0.2)],
    });
    const grown = await wait(h, alice, tankId, 20);
    const swapped = tankOf(
      await call(h, alice, 'PATCH', `/api/tanks/${tankId}`, {
        decorLayout: [layoutItem('acropora-cytherea', 31), layoutItem('brain-coral', 33, 0.3)],
      }),
    );
    expect(coralOf(swapped, 's31').size).toBeCloseTo(coralOf(grown, 's31').size, 2);
    expect(coralOf(swapped, 's33').size).toBe(1);
    expect(swapped.corals?.map((c) => c.key)).toEqual(['s31', 's33']);
    expect((await rowOf(h, tankId)).corals).toMatchObject([{ key: 's31' }, { key: 's33' }]);
  });

  it('answers a long absence with the last 60 days only', async () => {
    const tankId = await makeTank(h, alice, { layout: [layoutItem('brain-coral', 31)] });
    const t0 = Date.now();
    const tank = await wait(h, alice, tankId, 400);
    expect(coralOf(tank, 's31').size).toBeGreaterThan(1.1);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('ticks and saves a full coral layout with the most fragments', async () => {
    const layout = Array.from({ length: 200 }, (_, i) => layoutItem('brain-coral', 1000 + i));
    const tankId = await makeTank(h, alice, { layout });
    const total = 200 + maxFragsPerTank;
    const frags = Array.from({ length: maxFragsPerTank }, (_, i) => ({
      ...stored(`s1000.${i + 1}`, 0.5, 0, 'brain-coral'),
      parentKey: 's1000',
    }));
    await setCorals(h, tankId, [
      { ...stored('s1000', 1, 0, 'brain-coral'), spawned: maxFragsPerTank },
      ...frags,
    ]);
    expect((await wait(h, alice, tankId, 2)).corals).toHaveLength(total);
    const saved = tankOf(
      await call(h, alice, 'PATCH', `/api/tanks/${tankId}`, { decorLayout: layout }),
    );
    expect(saved.corals).toHaveLength(total);
    expect((await rowOf(h, tankId)).corals).toHaveLength(total);
    expect(tankOf(await call(h, alice, 'GET', `/api/tanks/${tankId}`)).corals).toHaveLength(total);
  });
});

describe('fragging a coral', () => {
  let h: Harness;
  let alice: Account;
  let mallory: Account;
  beforeAll(async () => {
    h = await createHarness({
      careLimits: { ...DEFAULT_CARE_LIMITS, care: { max: 60, windowMs: 60_000 } },
    });
    alice = await account(h);
    mallory = await account(h);
  });
  afterAll(() => h.close());

  async function grownTank(size = 2): Promise<string> {
    const tankId = await makeTank(h, alice);
    await setCorals(h, tankId, [stored('s31', size)]);
    return tankId;
  }

  it('cuts a fragment, the colony gives up its size, and both grow on', async () => {
    const tankId = await grownTank(2);
    const tank = tankOf(
      await frag(h, alice, tankId, { coralKey: 's31', idempotencyKey: randomUUID() }),
    );
    expect(coralOf(tank, 's31').size).toBeCloseTo(2 - fragStartSize, 6);
    const piece = coralOf(tank, 's31.1');
    expect(piece).toMatchObject({
      assetId: 'acropora-cytherea',
      parentKey: 's31',
      tintSeed: null,
      size: fragStartSize,
      bleach: 0,
    });
    expect(piece.position).toHaveLength(2);
    expect(await rowOf(h, tankId)).toMatchObject({
      corals: [{ key: 's31' }, { key: 's31.1', parentKey: 's31' }],
    });
    const later = await wait(h, alice, tankId, 10);
    expect(coralOf(later, 's31.1').size).toBeGreaterThan(fragStartSize);
    expect(coralOf(later, 's31').size).toBeGreaterThan(coralOf(tank, 's31').size);
  });

  it('judges the colony at its size now, not the size the client last saw', async () => {
    const tankId = await makeTank(h, alice);
    await setCorals(h, tankId, [stored('s31', 1.45)]);
    h.clock.advance(20 * DAY_MS);
    const res = await frag(h, alice, tankId, { coralKey: 's31', idempotencyKey: randomUUID() });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a colony just below the minimum and allows exactly the minimum', async () => {
    const under = await grownTank(minimum - 0.001);
    const refused = await frag(h, alice, under, { coralKey: 's31', idempotencyKey: randomUUID() });
    expect(refused.statusCode).toBe(409);
    expect(errorOf(refused).reason).toBe('coral_not_grown');
    expect((await rowOf(h, under)).corals).toMatchObject([{ key: 's31', size: minimum - 0.001 }]);

    const exact = await grownTank(minimum);
    const cut = await frag(h, alice, exact, { coralKey: 's31', idempotencyKey: randomUUID() });
    expect(coralOf(tankOf(cut), 's31').size).toBeCloseTo(minimum - fragStartSize, 6);
  });

  it('refuses a freshly bought colony', async () => {
    const tankId = await makeTank(h, alice);
    const res = await frag(h, alice, tankId, { coralKey: 's31', idempotencyKey: randomUUID() });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).reason).toBe('coral_not_grown');
  });

  it('refuses a bleached colony', async () => {
    const tankId = await makeTank(h, alice);
    await setCorals(h, tankId, [stored('s31', 2, 0.8)]);
    const res = await frag(h, alice, tankId, { coralKey: 's31', idempotencyKey: randomUUID() });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).reason).toBe('coral_bleached');
  });

  it('refuses once the tank holds the most fragments', async () => {
    const tankId = await makeTank(h, alice);
    const frags = Array.from({ length: maxFragsPerTank }, (_, i) => ({
      ...stored(`s31.${i + 1}`, 0.5),
      parentKey: 's31',
    }));
    await setCorals(h, tankId, [{ ...stored('s31', 2), spawned: maxFragsPerTank }, ...frags]);
    const res = await frag(h, alice, tankId, { coralKey: 's31', idempotencyKey: randomUUID() });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).reason).toBe('coral_limit');
  });

  it('answers 404 for an unknown coral', async () => {
    const tankId = await grownTank();
    const res = await frag(h, alice, tankId, { coralKey: 's999', idempotencyKey: randomUUID() });
    expect(res.statusCode).toBe(404);
  });

  it("answers 404 for another user's tank and leaves the colony alone", async () => {
    const tankId = await grownTank();
    const res = await frag(h, mallory, tankId, { coralKey: 's31', idempotencyKey: randomUUID() });
    expect(res.statusCode).toBe(404);
    expect((await rowOf(h, tankId)).corals).toMatchObject([{ key: 's31', size: 2 }]);
  });

  it('needs a session', async () => {
    const tankId = await grownTank();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/tanks/${tankId}/corals/frag`,
      headers: jsonHeaders,
      payload: { coralKey: 's31', idempotencyKey: randomUUID() },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a body without a key or with extra fields', async () => {
    const tankId = await grownTank();
    for (const body of [
      { coralKey: 's31' },
      { coralKey: 's31', idempotencyKey: randomUUID(), extra: 1 },
      { coralKey: 's31', idempotencyKey: 'short' },
      { idempotencyKey: randomUUID() },
    ]) {
      expect((await frag(h, alice, tankId, body)).statusCode).toBe(400);
    }
  });

  it('replays a retry with the same key instead of cutting again', async () => {
    const tankId = await grownTank(2.5);
    const body = { coralKey: 's31', idempotencyKey: randomUUID() };
    const first = tankOf(await frag(h, alice, tankId, body));
    const retry = tankOf(await frag(h, alice, tankId, body));
    expect(retry.corals?.map((c) => c.key)).toEqual(first.corals?.map((c) => c.key));
    expect(coralOf(retry, 's31').size).toBeCloseTo(coralOf(first, 's31').size, 6);
    expect((await rowOf(h, tankId)).corals).toHaveLength(2);
  });

  it('replays even once the colony is too small to cut again', async () => {
    const tankId = await grownTank(minimum);
    const body = { coralKey: 's31', idempotencyKey: randomUUID() };
    expect((await frag(h, alice, tankId, body)).statusCode).toBe(200);
    expect((await frag(h, alice, tankId, body)).statusCode).toBe(200);
  });

  it('refuses a key that was used for another coral', async () => {
    const tankId = await makeTank(h, alice, {
      layout: [layoutItem('acropora-cytherea', 31), layoutItem('brain-coral', 32, 0.2)],
    });
    await setCorals(h, tankId, [stored('s31', 2), stored('s32', 2, 0, 'brain-coral')]);
    const idempotencyKey = randomUUID();
    expect((await frag(h, alice, tankId, { coralKey: 's31', idempotencyKey })).statusCode).toBe(
      200,
    );
    const other = await frag(h, alice, tankId, { coralKey: 's32', idempotencyKey });
    expect(other.statusCode).toBe(409);
    expect(errorOf(other).reason).toBe('key_reused');
  });

  it('numbers successive fragments of one colony', async () => {
    const tankId = await grownTank(2.5);
    for (let i = 0; i < 3; i++) {
      await frag(h, alice, tankId, { coralKey: 's31', idempotencyKey: randomUUID() });
    }
    const row = await rowOf(h, tankId);
    expect((row.corals as { key: string }[]).map((c) => c.key)).toEqual([
      's31',
      's31.1',
      's31.2',
      's31.3',
    ]);
  });

  describe('around rock', () => {
    const boulder = (scale: number) => ({
      assetId: 'boulder-01',
      position: [0.05, 0.1, 0],
      rotationY: 0,
      scale,
      tintSeed: 77,
    });
    const footprint = plantTable.hardscape.get('boulder-01');
    if (!footprint) throw new Error('no boulder footprint');

    it('keeps every fragment out of the rock', async () => {
      const tankId = await makeTank(h, alice, {
        layout: [layoutItem('acropora-cytherea', 31, -0.17), boulder(1)],
      });
      await setCorals(h, tankId, [stored('s31', 2.5)]);
      let tank: Tank | null = null;
      for (let i = 0; i < 3; i++) {
        tank = tankOf(
          await frag(h, alice, tankId, { coralKey: 's31', idempotencyKey: randomUUID() }),
        );
      }
      const frags = tank?.corals?.filter((c) => c.parentKey !== null) ?? [];
      expect(frags).toHaveLength(3);
      for (const { position } of frags) {
        const [x, z] = position ?? [0, 0];
        const inside = Math.abs(x - 0.05) <= footprint.halfX && Math.abs(z) <= footprint.halfZ;
        expect(inside).toBe(false);
      }
    });

    it('refuses when rock fills the whole tank', async () => {
      const tankId = await makeTank(h, alice, {
        layout: [layoutItem('acropora-cytherea', 31, 0), boulder(10)],
      });
      await setCorals(h, tankId, [stored('s31', 2)]);
      const res = await frag(h, alice, tankId, { coralKey: 's31', idempotencyKey: randomUUID() });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).reason).toBe('coral_no_room');
      expect((await rowOf(h, tankId)).corals).toEqual([stored('s31', 2)]);
    });
  });

  describe.each(['nano30', 'long300'] as const)('on a %s tank with the default layout', (size) => {
    const roots = (presets.reef?.decor ?? [])
      .map((item) => fitPresetItem(item, size))
      .filter((item) => coralTable.species.has(coralSpeciesId(item.assetId)));

    it('keeps colonies where the client draws them', async () => {
      const tankId = await makeTank(h, alice, { layout: null, size });
      const tank = await wait(h, alice, tankId, 1);
      expect(tank.corals).toHaveLength(roots.length);
      const keys = tank.corals?.map((c) => c.key) ?? [];
      const row = (await rowOf(h, tankId)).corals as { key: string; position: [number, number] }[];
      expect(row.map((c) => c.key)).toEqual(keys);
      row.forEach((c, i) => {
        expect(c.position[0]).toBeCloseTo(roots[i]?.position[0] ?? NaN, 9);
        expect(c.position[1]).toBeCloseTo(roots[i]?.position[2] ?? NaN, 9);
      });
    });

    it('keeps grown colonies, fragments and plants across later ticks', async () => {
      const reef = await makeTank(h, alice, { layout: null, size });
      const first = (await wait(h, alice, reef, 1)).corals?.[0];
      if (!first) throw new Error('preset has no coral');
      const authored = (presets.reef?.decor ?? [])
        .filter((item) => coralTable.species.has(coralSpeciesId(item.assetId)))
        .map((item) => ({ ...item, tintSeed: legacyTintSeed(item) }));
      const expectedKeys = layoutPlantKeys(authored);
      expect(expectedKeys.length).toBeGreaterThan(1);
      expect((await wait(h, alice, reef, 0)).corals?.map((c) => c.key)).toEqual(expectedKeys);
      expect(first.key).toBe(expectedKeys[0]);
      const row = (await rowOf(h, reef)).corals as { key: string; size: number }[];
      await setCorals(
        h,
        reef,
        row.map((c) => (c.key === first.key ? { ...c, size: 3 } : c)),
      );
      const cut = tankOf(
        await frag(h, alice, reef, { coralKey: first.key, idempotencyKey: randomUUID() }),
      );
      const keys = cut.corals?.map((c) => c.key) ?? [];
      expect(keys).toContain(`${first.key}.1`);
      const later = await wait(h, alice, reef, 1);
      expect(later.corals?.map((c) => c.key)).toEqual(keys);
      expect(coralOf(later, first.key).size).toBeGreaterThan(2);
      expect(coralOf(later, `${first.key}.1`).parentKey).toBe(first.key);

      const pond = await makeTank(h, alice, { layout: null, size, biome: 'freshwater' });
      const seeded = (await wait(h, alice, pond, 1)).plants?.map((p) => p.key) ?? [];
      const authoredPlants = (presets.freshwater?.decor ?? [])
        .filter((item) => plantTable.species.has(item.assetId))
        .map((item) => ({ ...item, tintSeed: legacyTintSeed(item) }));
      expect(seeded).toEqual(layoutPlantKeys(authoredPlants));
      expect(seeded.length).toBeGreaterThan(0);
      const plantRows = (await rowOf(h, pond)).plants as { size: number }[];
      await h.database.db
        .update(schema.tanks)
        .set({
          plants: plantRows.map((p) => ({ ...p, size: 2 })),
          lastTickAt: new Date(h.clock.now()),
        })
        .where(eq(schema.tanks.id, pond));
      const settled = await wait(h, alice, pond, 1);
      expect(settled.plants?.map((p) => p.key)).toEqual(seeded);
      expect(settled.plants?.every((p) => p.size >= 1.9)).toBe(true);
    });

    it('cuts fragments beside the fitted colony and inside the 3 cm margin', async () => {
      const tankId = await makeTank(h, alice, { layout: null, size });
      const first = (await wait(h, alice, tankId, 1)).corals?.[0];
      const root = roots[0];
      if (!first || !root) throw new Error('preset has no coral');
      const row = (await rowOf(h, tankId)).corals as { key: string; size: number }[];
      await setCorals(
        h,
        tankId,
        row.map((c) => (c.key === first.key ? { ...c, size: 3 } : c)),
      );
      const bounds = substrateBounds(size);
      const { edgeMarginM, fragRadiusM } = coralTable.params;
      for (let i = 0; i < 6; i++) {
        const tank = tankOf(
          await frag(h, alice, tankId, { coralKey: first.key, idempotencyKey: randomUUID() }),
        );
        const [x, z] = tank.corals?.findLast((c) => c.parentKey === first.key)?.position ?? [
          Infinity,
          Infinity,
        ];
        expect(Math.abs(x)).toBeLessThanOrEqual(bounds.halfX - edgeMarginM + 1e-9);
        expect(Math.abs(z)).toBeLessThanOrEqual(bounds.halfZ - edgeMarginM + 1e-9);
        expect(Math.hypot(x - root.position[0], z - root.position[2])).toBeLessThanOrEqual(
          fragRadiusM + edgeMarginM,
        );
      }
    });
  });

  it('remembers only the last 16 keys', async () => {
    const big = await createHarness({
      careLimits: { ...DEFAULT_CARE_LIMITS, care: { max: 1000, windowMs: 60_000 } },
    });
    try {
      const who = await account(big);
      const id = await makeTank(big, who);
      await setCorals(big, id, [stored('s31', 2.5)]);
      for (let i = 0; i < 17; i++) {
        const res = await frag(big, who, id, { coralKey: 's31', idempotencyKey: randomUUID() });
        expect(res.statusCode).toBe(200);
        await setCorals(big, id, [
          { ...stored('s31', 2.5), spawned: i + 1 },
          ...(((await rowOf(big, id)).corals as { key: string }[]).slice(1) as object[]),
        ]);
      }
      expect((await rowOf(big, id)).coralFragKeys).toHaveLength(16);
    } finally {
      await big.close();
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
      await setCorals(limited, id, [stored('s31', 2.5)]);
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        codes.push(
          (await frag(limited, who, id, { coralKey: 's31', idempotencyKey: randomUUID() }))
            .statusCode,
        );
      }
      expect(codes).toEqual([200, 200, 429, 429]);
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
      await setCorals(limited, id, [stored('s31', 2.5)]);
      const body = { coralKey: 's31', idempotencyKey: randomUUID() };
      for (let i = 0; i < 5; i++) {
        expect((await frag(limited, who, id, body)).statusCode).toBe(200);
      }
      const fresh = { coralKey: 's31', idempotencyKey: randomUUID() };
      expect((await frag(limited, who, id, fresh)).statusCode).toBe(200);
      const over = { coralKey: 's31', idempotencyKey: randomUUID() };
      expect((await frag(limited, who, id, over)).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
