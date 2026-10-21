import { randomUUID } from 'node:crypto';
import {
  apiErrorSchema,
  tankSchema,
  treatResponseSchema,
  walletResponseSchema,
  type Tank,
} from '@aquarium/shared';
import { courseHours, MAX_CATCH_UP_MS } from '@aquarium/sim/lifecycle';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from './db/index.ts';
import { loadEconomy } from './economy.ts';
import { APP_ORIGIN, createHarness, topUp, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
const HOUR_MS = 3_600_000;
const economy = loadEconomy();
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

interface Account {
  cookie: string;
  userId: string;
}

async function account(h: Harness): Promise<Account> {
  const email = `t37-${Date.now()}-${counter++}@bas.lu`;
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
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie: who.cookie },
    ...(payload ? { payload } : {}),
  });

const errorCode = (res: LightMyRequestResponse) => apiErrorSchema.parse(res.json()).error.code;
const errorReason = (res: LightMyRequestResponse) => apiErrorSchema.parse(res.json()).error.reason;

async function sickTank(
  h: Harness,
  kind: 'ich' | 'fin-rot' | 'velvet' = 'ich',
  severity = 0.3,
  owner?: Account,
) {
  const who = owner ?? (await account(h));
  const created = await call(h, who, 'POST', '/api/tanks', {
    name: 'Home',
    biome: 'freshwater',
    idempotencyKey: randomUUID(),
  });
  expect(created.statusCode).toBe(201);
  const tank = tankSchema.parse(created.json());
  const bought = await call(h, who, 'POST', `/api/tanks/${tank.id}/fish`, {
    species: 'neon-tetra',
    name: 'Buddy',
    stage: 'adult',
    idempotencyKey: randomUUID(),
  });
  expect(bought.statusCode).toBe(201);
  const [row] = await h.database.db
    .select()
    .from(schema.fish)
    .where(eq(schema.fish.tankId, tank.id));
  if (!row) throw new Error('fish missing');
  await h.database.db
    .update(schema.fish)
    .set({
      disease: {
        kind,
        since: new Date(h.clock.now()).toISOString(),
        severity,
        treatedUntil: null,
      },
    })
    .where(eq(schema.fish.id, row.id));
  return { who, tankId: tank.id, fishId: row.id };
}

// A fish inside its new-fish window rolls a random fresh ich or velvet every hour, seeded by its random
// id and the wall-clock time, so after the cure it can catch a different disease and the assertions
// below flake. Settled fish in clean water have zero onset rate, which makes the outcome deterministic.
const settleIn = (h: Harness, fishId: string) =>
  h.database.db.update(schema.fish).set({ introducedAt: null }).where(eq(schema.fish.id, fishId));

const treat = (h: Harness, who: Account, tankId: string, body: object) =>
  call(h, who, 'POST', `/api/tanks/${tankId}/treat`, { idempotencyKey: randomUUID(), ...body });

const fishOf = (tank: Tank, id: string) => {
  const fish = tank.fish.find((f) => f.id === id);
  if (!fish) throw new Error('fish missing from tank');
  return fish;
};

const getTank = async (h: Harness, who: Account, tankId: string) => {
  const res = await call(h, who, 'GET', `/api/tanks/${tankId}`);
  expect(res.statusCode).toBe(200);
  return tankSchema.parse(res.json());
};

const balance = async (h: Harness, who: Account) =>
  walletResponseSchema.parse((await call(h, who, 'GET', '/api/wallet')).json()).wallet.balance;

describe('treatment', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  describe('authorisation and input', () => {
    it('refuses an anonymous caller', async () => {
      const { tankId } = await sickTank(h);
      const res = await treat(h, { cookie: '', userId: '' }, tankId, { kind: 'ich' });
      expect(res.statusCode).toBe(401);
    });

    it("refuses another player's tank without leaking that it exists", async () => {
      const { tankId } = await sickTank(h);
      const stranger = await account(h);
      const res = await treat(h, stranger, tankId, { kind: 'ich' });
      expect(res.statusCode).toBe(404);
      const absent = await treat(h, stranger, randomUUID(), { kind: 'ich' });
      expect(absent.statusCode).toBe(404);
    });

    it.each([{}, { kind: 'plague' }, { kind: 'ich', potency: 'free' }, { kind: 'ich', extra: 1 }])(
      'rejects the body %j',
      async (body) => {
        const { who, tankId } = await sickTank(h);
        expect((await treat(h, who, tankId, body)).statusCode).toBe(400);
      },
    );

    it.each(['standard', 'premium'] as const)(
      'rejects %s medicine sent without idempotencyKey and changes nothing',
      async (potency) => {
        const { who, tankId } = await sickTank(h);
        const before = await balance(h, who);
        const ledgerBefore = await h.database.db
          .select()
          .from(schema.ledger)
          .where(eq(schema.ledger.userId, who.userId));
        const res = await call(h, who, 'POST', `/api/tanks/${tankId}/treat`, {
          kind: 'ich',
          potency,
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.stringify(res.json())).toContain('idempotencyKey');
        expect(await balance(h, who)).toBe(before);
        const ledgerAfter = await h.database.db
          .select()
          .from(schema.ledger)
          .where(eq(schema.ledger.userId, who.userId));
        expect(ledgerAfter).toHaveLength(ledgerBefore.length);
        expect((await getTank(h, who, tankId)).medicine).toBeNull();
      },
    );
  });

  describe('standard medicine', () => {
    it('refuses to treat a disease no fish in the tank has', async () => {
      const { who, tankId } = await sickTank(h, 'ich');
      const res = await treat(h, who, tankId, { kind: 'velvet' });
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe('conflict');
      expect(errorReason(res)).toBe('nothing_to_treat');
      expect(apiErrorSchema.parse(res.json()).error.message).toContain('Velvet');
    });

    it('is free, starts the course and marks the sick fish as treated', async () => {
      const { who, tankId, fishId } = await sickTank(h);
      const before = await balance(h, who);
      const res = await treat(h, who, tankId, { kind: 'ich' });
      expect(res.statusCode).toBe(200);
      const body = treatResponseSchema.parse(res.json());
      expect(body.overdose).toBe(false);
      expect(body.wallet).toBeNull();
      expect(body.entry).toBeNull();
      expect(body.tank.medicine).toMatchObject({ kind: 'ich', potency: 'standard', doses: 1 });
      const until = Date.parse(body.tank.medicine?.until ?? '');
      expect(until - h.clock.now()).toBeCloseTo(courseHours('ich', 'standard') * HOUR_MS, -4);
      expect(fishOf(body.tank, fishId).disease?.treatedUntil).toBe(body.tank.medicine?.until);
      expect(await balance(h, who)).toBe(before);
    });

    it('is never blocked by an empty wallet', async () => {
      const { who, tankId } = await sickTank(h);
      await h.database.db
        .update(schema.wallet)
        .set({ balance: 0 })
        .where(eq(schema.wallet.userId, who.userId));
      expect((await treat(h, who, tankId, { kind: 'ich' })).statusCode).toBe(200);
    });

    it('cures the fish when the whole course runs', async () => {
      const { who, tankId, fishId } = await sickTank(h, 'ich', 0.4);
      await settleIn(h, fishId);
      await treat(h, who, tankId, { kind: 'ich' });
      h.clock.advance((courseHours('ich', 'standard') + 1) * HOUR_MS);
      const tank = await getTank(h, who, tankId);
      expect(fishOf(tank, fishId).disease).toBeNull();
      expect(fishOf(tank, fishId).status).toBe('alive');
      expect(tank.medicine).toBeNull();
    });

    it('leaves the disease progressing without a course', async () => {
      const { who, tankId, fishId } = await sickTank(h, 'ich', 0.3);
      h.clock.advance(24 * HOUR_MS);
      const fish = fishOf(await getTank(h, who, tankId), fishId);
      expect(fish.disease?.severity ?? 1).toBeGreaterThan(0.3);
    });

    it('loses part of the course to a water change', async () => {
      const { who, tankId } = await sickTank(h, 'ich', 0.9);
      await treat(h, who, tankId, { kind: 'ich' });
      h.clock.advance(12 * HOUR_MS);
      const care = await call(h, who, 'POST', `/api/tanks/${tankId}/care`, {
        type: 'water_change',
      });
      expect(care.statusCode).toBe(200);
      const tank = await getTank(h, who, tankId);
      const remaining = Date.parse(tank.medicine?.until ?? '') - h.clock.now();
      expect(remaining).toBeLessThan((courseHours('ich', 'standard') - 12) * HOUR_MS);
    });
  });

  describe('overdose', () => {
    it('does not call a dose after a water change an overdose', async () => {
      const { who, tankId } = await sickTank(h, 'ich', 0.9);
      await treat(h, who, tankId, { kind: 'ich' });
      h.clock.advance(12 * HOUR_MS);
      const care = await call(h, who, 'POST', `/api/tanks/${tankId}/care`, {
        type: 'water_change',
      });
      expect(care.statusCode).toBe(200);
      const again = treatResponseSchema.parse(
        (await treat(h, who, tankId, { kind: 'ich' })).json(),
      );
      expect(again.overdose).toBe(false);
      expect(again.tank.medicine?.doses).toBe(1);
    });

    it('flags a second dose, poisons the fish and stops at the limit', async () => {
      const { who, tankId, fishId } = await sickTank(h, 'ich', 0.2);
      const first = treatResponseSchema.parse(
        (await treat(h, who, tankId, { kind: 'ich' })).json(),
      );
      expect(first.overdose).toBe(false);
      const second = treatResponseSchema.parse(
        (await treat(h, who, tankId, { kind: 'ich' })).json(),
      );
      expect(second.overdose).toBe(true);
      expect(second.tank.medicine?.doses).toBe(2);
      const third = await treat(h, who, tankId, { kind: 'ich' });
      expect(third.statusCode).toBe(200);
      const fourth = await treat(h, who, tankId, { kind: 'ich' });
      expect(fourth.statusCode).toBe(409);
      expect(errorReason(fourth)).toBe('dose_limit');
      h.clock.advance(6 * HOUR_MS);
      const fish = fishOf(await getTank(h, who, tankId), fishId);
      expect(fish.health).toBeLessThan(1);
    });

    it('refuses a second kind of medicine while one is in the water', async () => {
      const { who, tankId } = await sickTank(h, 'ich');
      const bought = await call(h, who, 'POST', `/api/tanks/${tankId}/fish`, {
        species: 'neon-tetra',
        name: 'Second',
        stage: 'adult',
        idempotencyKey: randomUUID(),
      });
      expect(bought.statusCode).toBe(201);
      const rows = await h.database.db
        .select()
        .from(schema.fish)
        .where(eq(schema.fish.tankId, tankId));
      const healthy = rows.find((r) => r.disease === null);
      if (!healthy) throw new Error('second fish missing');
      await h.database.db
        .update(schema.fish)
        .set({
          disease: {
            kind: 'velvet',
            since: new Date(h.clock.now()).toISOString(),
            severity: 0.3,
            treatedUntil: null,
          },
        })
        .where(eq(schema.fish.id, healthy.id));
      expect((await treat(h, who, tankId, { kind: 'ich' })).statusCode).toBe(200);
      const res = await treat(h, who, tankId, { kind: 'velvet' });
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe('conflict');
      expect(errorReason(res)).toBe('other_medicine');
    });

    it('treats another disease after a water change leaves only a residue', async () => {
      const { who, tankId } = await sickTank(h, 'ich');
      const bought = await call(h, who, 'POST', `/api/tanks/${tankId}/fish`, {
        species: 'neon-tetra',
        name: 'Second',
        stage: 'adult',
        idempotencyKey: randomUUID(),
      });
      expect(bought.statusCode).toBe(201);
      const rows = await h.database.db
        .select()
        .from(schema.fish)
        .where(eq(schema.fish.tankId, tankId));
      const healthy = rows.find((r) => r.disease === null);
      if (!healthy) throw new Error('second fish missing');
      await h.database.db
        .update(schema.fish)
        .set({
          disease: {
            kind: 'velvet',
            since: new Date(h.clock.now()).toISOString(),
            severity: 0.3,
            treatedUntil: null,
          },
        })
        .where(eq(schema.fish.id, healthy.id));
      expect((await treat(h, who, tankId, { kind: 'ich' })).statusCode).toBe(200);
      const care = await call(h, who, 'POST', `/api/tanks/${tankId}/care`, {
        type: 'water_change',
      });
      expect(care.statusCode).toBe(200);
      const res = await treat(h, who, tankId, { kind: 'velvet' });
      expect(res.statusCode).toBe(200);
      const dosed = treatResponseSchema.parse(res.json());
      expect(dosed.overdose).toBe(false);
      expect(dosed.tank.medicine?.kind).toBe('velvet');
      expect(dosed.tank.medicine?.doses).toBe(1);
    });
  });

  describe('premium medicine', () => {
    const price = economy.items.consumables.premiumMedicine.prices['ich'] ?? 0;

    it('charges the price, runs a shorter course and records the purchase', async () => {
      const { who, tankId } = await sickTank(h);
      const before = await balance(h, who);
      const res = await treat(h, who, tankId, {
        kind: 'ich',
        potency: 'premium',
        idempotencyKey: randomUUID(),
      });
      expect(res.statusCode).toBe(200);
      const body = treatResponseSchema.parse(res.json());
      expect(body.wallet?.balance).toBe(before - price);
      expect(body.entry).toMatchObject({ delta: -price, reason: 'purchase' });
      expect(body.entry?.itemRef).toBe(`consumable:premium-medicine:ich:${tankId}`);
      const until = Date.parse(body.tank.medicine?.until ?? '');
      expect(until - h.clock.now()).toBeCloseTo(courseHours('ich', 'premium') * HOUR_MS, -4);
      expect(await balance(h, who)).toBe(before - price);
    });

    it('charges once for a replayed idempotency key', async () => {
      const { who, tankId } = await sickTank(h);
      const before = await balance(h, who);
      const body = { kind: 'ich', potency: 'premium', idempotencyKey: randomUUID() };
      expect((await treat(h, who, tankId, body)).statusCode).toBe(200);
      const replay = await treat(h, who, tankId, body);
      expect(replay.statusCode).toBe(200);
      expect(treatResponseSchema.parse(replay.json()).tank.medicine?.doses).toBe(1);
      expect(await balance(h, who)).toBe(before - price);
    });

    it('refuses a key reused for another medicine', async () => {
      const { who, tankId } = await sickTank(h);
      const idempotencyKey = randomUUID();
      await treat(h, who, tankId, { kind: 'ich', potency: 'premium', idempotencyKey });
      const res = await treat(h, who, tankId, {
        kind: 'velvet',
        potency: 'premium',
        idempotencyKey,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('answers insufficient_pearls and leaves the tank untreated', async () => {
      const { who, tankId } = await sickTank(h);
      await h.database.db
        .update(schema.wallet)
        .set({ balance: price - 1 })
        .where(eq(schema.wallet.userId, who.userId));
      const res = await treat(h, who, tankId, { kind: 'ich', potency: 'premium' });
      expect(res.statusCode).toBe(402);
      expect(errorCode(res)).toBe('insufficient_pearls');
      expect((await getTank(h, who, tankId)).medicine).toBeNull();
    });

    it('charges nothing for a dose the water cannot take', async () => {
      const { who, tankId } = await sickTank(h, 'ich', 0.2);
      for (let i = 0; i < 3; i++) await treat(h, who, tankId, { kind: 'ich' });
      const before = await balance(h, who);
      const res = await treat(h, who, tankId, { kind: 'ich', potency: 'premium' });
      expect(res.statusCode).toBe(409);
      expect(await balance(h, who)).toBe(before);
    });
  });

  describe('idempotency', () => {
    it('replays a standard dose retried with the same key instead of overdosing', async () => {
      const { who, tankId } = await sickTank(h);
      const body = { kind: 'ich', idempotencyKey: randomUUID() };
      const first = treatResponseSchema.parse((await treat(h, who, tankId, body)).json());
      const retry = await treat(h, who, tankId, body);
      expect(retry.statusCode).toBe(200);
      const replayed = treatResponseSchema.parse(retry.json());
      expect(replayed.overdose).toBe(false);
      expect(replayed.tank.medicine).toEqual(first.tank.medicine);
      expect(replayed.tank.medicine?.doses).toBe(1);
    });

    it('lets two parallel standard calls with one key dose once', async () => {
      const { who, tankId } = await sickTank(h);
      const body = { kind: 'ich', idempotencyKey: randomUUID() };
      const [a, b] = await Promise.all([treat(h, who, tankId, body), treat(h, who, tankId, body)]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      const tank = await getTank(h, who, tankId);
      expect(tank.medicine?.doses).toBe(1);
      expect(treatResponseSchema.parse(a.json()).overdose).toBe(false);
      expect(treatResponseSchema.parse(b.json()).overdose).toBe(false);
    });

    it('charges once for two parallel premium calls with one key', async () => {
      const { who, tankId } = await sickTank(h);
      const before = await balance(h, who);
      const body = { kind: 'ich', potency: 'premium', idempotencyKey: randomUUID() };
      const [a, b] = await Promise.all([treat(h, who, tankId, body), treat(h, who, tankId, body)]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect((await getTank(h, who, tankId)).medicine?.doses).toBe(1);
      expect(await balance(h, who)).toBe(
        before - (economy.items.consumables.premiumMedicine.prices['ich'] ?? 0),
      );
    });

    it('still doses twice when the keys differ', async () => {
      const { who, tankId } = await sickTank(h);
      await treat(h, who, tankId, { kind: 'ich', idempotencyKey: randomUUID() });
      const second = treatResponseSchema.parse(
        (await treat(h, who, tankId, { kind: 'ich', idempotencyKey: randomUUID() })).json(),
      );
      expect(second.overdose).toBe(true);
    });

    it('replays the original overdose flag on a premium retry', async () => {
      const { who, tankId } = await sickTank(h);
      await treat(h, who, tankId, { kind: 'ich' });
      const body = { kind: 'ich', potency: 'premium', idempotencyKey: randomUUID() };
      const first = treatResponseSchema.parse((await treat(h, who, tankId, body)).json());
      expect(first.overdose).toBe(true);
      const retry = treatResponseSchema.parse((await treat(h, who, tankId, body)).json());
      expect(retry.overdose).toBe(true);
    });

    it('refuses a key reused for another potency', async () => {
      const { who, tankId } = await sickTank(h);
      const idempotencyKey = randomUUID();
      await treat(h, who, tankId, { kind: 'ich', idempotencyKey });
      const res = await treat(h, who, tankId, { kind: 'ich', potency: 'premium', idempotencyKey });
      expect(res.statusCode).toBe(409);
      expect(errorReason(res)).toBe('key_reused');
    });

    it('refuses a premium key reused on another tank, without charging', async () => {
      const first = await sickTank(h);
      await topUp(h);
      const second = await sickTank(h, 'ich', 0.3, first.who);
      const idempotencyKey = randomUUID();
      const body = { kind: 'ich', potency: 'premium', idempotencyKey };
      expect((await treat(h, first.who, first.tankId, body)).statusCode).toBe(200);
      const before = await balance(h, first.who);
      const res = await treat(h, first.who, second.tankId, body);
      expect(res.statusCode).toBe(409);
      expect(await balance(h, first.who)).toBe(before);
      expect((await getTank(h, first.who, second.tankId)).medicine).toBeNull();
    });
  });

  describe('time', () => {
    it('reads the same tank after a long absence, bounded by the catch-up cap', async () => {
      const { who, tankId } = await sickTank(h, 'velvet', 0.5);
      h.clock.advance(MAX_CATCH_UP_MS * 3);
      const tank = await getTank(h, who, tankId);
      expect(tank.fish.every((f) => f.status === 'dead')).toBe(true);
      const [row] = await h.database.db
        .select()
        .from(schema.tanks)
        .where(eq(schema.tanks.id, tankId));
      expect(row?.lastTickAt.getTime()).toBeLessThanOrEqual(h.clock.now());
    });

    it('treats nothing once the sick fish has died', async () => {
      const { who, tankId } = await sickTank(h, 'velvet', 0.9);
      h.clock.advance(MAX_CATCH_UP_MS);
      expect((await treat(h, who, tankId, { kind: 'velvet' })).statusCode).toBe(409);
    });
  });
});
