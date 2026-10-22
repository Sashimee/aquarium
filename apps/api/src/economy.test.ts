import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ACHIEVEMENTS,
  apiErrorSchema,
  dataExportSchema,
  idempotencyKeySchema,
  PRIVACY_POLICY,
  purchaseResponseSchema,
  sellFryResponseSchema,
  tankSchema,
  walletResponseSchema,
  type Tank,
} from '@aquarium/shared';
import { and, eq, like, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from './db/index.ts';
import { loadEconomy } from './economy.ts';
import { personalityFromFishId } from './personality.ts';
import { loadPresets } from './presets.ts';
import { loadCatalog } from './species.ts';
import { DEFAULT_CARE_LIMITS } from './tanks.ts';
import { APP_ORIGIN, createHarness, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
const DAY_MS = 86_400_000;
const economy = loadEconomy();
const presets = loadPresets();
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

interface Account {
  cookie: string;
  userId: string;
}

async function account(h: Harness): Promise<Account> {
  const email = `t70-${Date.now()}-${counter++}@bas.lu`;
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) =>
  h.app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie: who.cookie },
    ...(payload ? { payload } : {}),
  });

const key = () => randomUUID();

async function walletOf(h: Harness, who: Account) {
  const res = await call(h, who, 'GET', '/api/wallet');
  expect(res.statusCode).toBe(200);
  return walletResponseSchema.parse(res.json());
}

async function balance(h: Harness, who: Account) {
  return (await walletOf(h, who)).wallet.balance;
}

async function ledgerOf(h: Harness, who: Account) {
  return h.database.db
    .select()
    .from(schema.ledger)
    .where(eq(schema.ledger.userId, who.userId))
    .orderBy(schema.ledger.createdAt);
}

async function setBalance(h: Harness, who: Account, target: number) {
  const current = await balance(h, who);
  if (current === target) return;
  await h.database.db.insert(schema.ledger).values({
    userId: who.userId,
    delta: target - current,
    reason: 'grant',
    source: 'game',
    itemRef: 'grant:test-adjust',
    idempotencyKey: `adjust-${key()}`,
    createdAt: new Date(h.clock.now()),
  });
  await h.database.db
    .update(schema.wallet)
    .set({ balance: target })
    .where(eq(schema.wallet.userId, who.userId));
}

async function createTank(
  h: Harness,
  who: Account,
  extra: {
    biome?: 'freshwater' | 'reef' | 'blackwater' | 'mangrove';
    size?: string;
    quarantine?: boolean;
    key?: string;
  } = {},
) {
  const { key: idempotencyKey, ...rest } = extra;
  return call(h, who, 'POST', '/api/tanks', {
    name: 'Home',
    biome: 'freshwater',
    ...rest,
    idempotencyKey: idempotencyKey ?? key(),
  });
}

async function freeTank(
  h: Harness,
  who: Account,
  biome: 'freshwater' | 'reef' | 'blackwater' = 'freshwater',
) {
  const res = await createTank(h, who, { biome });
  expect(res.statusCode).toBe(201);
  return tankSchema.parse(res.json());
}

const buyFish = (
  h: Harness,
  who: Account,
  tankId: string,
  species: string,
  stage: 'juvenile' | 'adult',
  idempotencyKey = key(),
) =>
  call(h, who, 'POST', `/api/tanks/${tankId}/fish`, {
    species,
    name: 'Buddy',
    stage,
    idempotencyKey,
  });

const purchase = (h: Harness, who: Account, itemRef: string, tankId?: string, k = key()) =>
  call(h, who, 'POST', '/api/shop/purchase', {
    idempotencyKey: k,
    itemRef,
    ...(tankId ? { tankId } : {}),
  });

const errorCode = (res: LightMyRequestResponse) => apiErrorSchema.parse(res.json()).error.code;

async function primed(h: Harness) {
  const who = await account(h);
  const tank = await freeTank(h, who);
  expect((await buyFish(h, who, tank.id, 'neon-tetra', 'juvenile')).statusCode).toBe(201);
  await walletOf(h, who);
  return { who, tank };
}

const sumLedger = async (h: Harness, who: Account) =>
  (await ledgerOf(h, who)).reduce((total, row) => total + row.delta, 0);

describe('wallet, shop and ledger', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('requires a verified session for the wallet and the shop', async () => {
    const anon = { cookie: '', userId: '' };
    expect((await call(h, anon, 'GET', '/api/wallet')).statusCode).toBe(401);
    expect((await purchase(h, anon, 'background:bg-fw-misty-lake')).statusCode).toBe(401);
  });

  it('opens a wallet with the starting grant and one ledger row for it', async () => {
    const who = await account(h);
    const { wallet, ledger } = await walletOf(h, who);
    expect(wallet.balance).toBe(economy.grants.starting);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      delta: economy.grants.starting,
      reason: 'grant',
      source: 'game',
      itemRef: 'grant:starting',
    });
    expect((await walletOf(h, who)).ledger).toHaveLength(1);
  });

  describe('owned refs', () => {
    const insertRows = (
      who: Account,
      rows: { itemRef: string; reason: 'purchase' | 'refund'; at: number }[],
    ) =>
      h.database.db.insert(schema.ledger).values(
        rows.map((r) => ({
          userId: who.userId,
          delta: r.reason === 'purchase' ? -1 : 1,
          reason: r.reason,
          source: 'game' as const,
          itemRef: r.itemRef,
          idempotencyKey: `own-${key()}`,
          createdAt: new Date(r.at),
        })),
      );

    it('is empty for a fresh wallet', async () => {
      const who = await account(h);
      expect((await walletOf(h, who)).owned).toEqual([]);
    });

    it('lists a purchase and keeps old ones beyond the ledger page', async () => {
      const who = await account(h);
      await walletOf(h, who);
      const base = h.clock.now();
      await insertRows(who, [
        { itemRef: 'background:bg-fw-misty-lake', reason: 'purchase', at: base - 10_000_000 },
        ...Array.from({ length: 120 }, (_, i) => ({
          itemRef: `decor:filler-${i}`,
          reason: 'purchase' as const,
          at: base - 5_000_000 + i,
        })),
      ]);
      const wallet = await walletOf(h, who);
      expect(wallet.ledger).toHaveLength(100);
      expect(wallet.ledger.some((e) => e.itemRef === 'background:bg-fw-misty-lake')).toBe(false);
      expect(wallet.owned).toContain('background:bg-fw-misty-lake');
      expect(wallet.owned).toHaveLength(121);
    });

    it('drops a ref whose latest entry is a refund and restores a rebuy', async () => {
      const who = await account(h);
      await walletOf(h, who);
      const base = h.clock.now();
      await insertRows(who, [
        { itemRef: 'decor:a', reason: 'purchase', at: base - 4000 },
        { itemRef: 'decor:a', reason: 'refund', at: base - 3000 },
        { itemRef: 'decor:b', reason: 'purchase', at: base - 4000 },
        { itemRef: 'decor:b', reason: 'refund', at: base - 3000 },
        { itemRef: 'decor:b', reason: 'purchase', at: base - 2000 },
      ]);
      expect((await walletOf(h, who)).owned).toEqual(['decor:b']);
    });

    it('lists only one-time plant, decor and background refs', async () => {
      const who = await account(h);
      await walletOf(h, who);
      const base = h.clock.now();
      await insertRows(who, [
        { itemRef: 'plant:java-fern', reason: 'purchase', at: base - 9000 },
        { itemRef: 'decor:driftwood', reason: 'purchase', at: base - 9000 },
        { itemRef: 'background:bg-fw-misty-lake', reason: 'purchase', at: base - 9000 },
        { itemRef: 'species:neon-tetra:adult', reason: 'purchase', at: base - 9000 },
        { itemRef: `tank:standard:${randomUUID()}`, reason: 'purchase', at: base - 9000 },
        { itemRef: 'consumable:bottled-bacteria', reason: 'purchase', at: base - 9000 },
        { itemRef: 'equipment:heater:2', reason: 'purchase', at: base - 9000 },
      ]);
      await h.database.db.insert(schema.ledger).values({
        userId: who.userId,
        delta: 10,
        reason: 'earn',
        source: 'game',
        itemRef: 'decor:from-an-earn-row',
        idempotencyKey: `own-${key()}`,
        createdAt: new Date(base - 8000),
      });
      expect((await walletOf(h, who)).owned).toEqual([
        'background:bg-fw-misty-lake',
        'decor:driftwood',
        'plant:java-fern',
      ]);
    });

    it('lets a refund win a timestamp tie, and a later rebuy win after it', async () => {
      const who = await account(h);
      await walletOf(h, who);
      const at = h.clock.now() - 5000;
      await insertRows(who, [
        { itemRef: 'decor:tie', reason: 'purchase', at },
        { itemRef: 'decor:tie', reason: 'refund', at },
        { itemRef: 'decor:again', reason: 'purchase', at },
        { itemRef: 'decor:again', reason: 'refund', at },
        { itemRef: 'decor:again', reason: 'purchase', at: at + 1 },
      ]);
      expect((await walletOf(h, who)).owned).toEqual(['decor:again']);
    });

    it("never shows another user's purchases or real-money rows", async () => {
      const mine = await account(h);
      const other = await account(h);
      await walletOf(h, mine);
      await walletOf(h, other);
      await insertRows(other, [{ itemRef: 'decor:theirs', reason: 'purchase', at: h.clock.now() }]);
      await h.database.db.insert(schema.ledger).values({
        userId: mine.userId,
        delta: 550,
        reason: 'pack',
        source: 'stripe',
        itemRef: 'pack:pearls-550',
        idempotencyKey: `pack-${key()}`,
        createdAt: new Date(h.clock.now()),
      });
      expect((await walletOf(h, mine)).owned).toEqual([]);
      expect((await walletOf(h, other)).owned).toEqual(['decor:theirs']);
    });
  });

  describe('fish', () => {
    it('charges the juvenile and the adult price and stores the matching fish', async () => {
      const who = await account(h);
      const tank = await freeTank(h, who);
      const catalog = loadCatalog().get('neon-tetra');
      if (!catalog) throw new Error('neon-tetra missing');
      const price = economy.species['neon-tetra'];
      if (!price) throw new Error('neon-tetra unpriced');

      const juvenile = await buyFish(h, who, tank.id, 'neon-tetra', 'juvenile');
      expect(juvenile.statusCode).toBe(201);
      const adult = await buyFish(h, who, tank.id, 'neon-tetra', 'adult');
      expect(adult.statusCode).toBe(201);

      const purchases = (await ledgerOf(h, who)).filter((r) => r.reason === 'purchase');
      expect(purchases.map((r) => [r.itemRef, r.delta])).toEqual([
        ['species:neon-tetra:juvenile', -price.juvenile],
        ['species:neon-tetra:adult', -price.adult],
      ]);
      expect(price.adult).toBeGreaterThan(price.juvenile);

      const fish = tankSchema.parse(adult.json()).fish;
      const young = fish.find((f) => f.stage === 'juvenile');
      const grown = fish.find((f) => f.stage === 'adult');
      expect(young?.size).toBe(catalog.lifecycle.birthSizeM);
      expect(grown?.size).toBe(catalog.lifecycle.maxSizeM);
      expect(await sumLedger(h, who)).toBe(await balance(h, who));
    });

    it('never overdraws: the purchase that does not fit is refused and leaves no trace', async () => {
      const { who, tank } = await primed(h);
      await setBalance(h, who, 449);
      const price = economy.species['angelfish']?.adult ?? 0;
      expect(price).toBe(150);
      for (let i = 0; i < 2; i++) {
        expect((await buyFish(h, who, tank.id, 'angelfish', 'adult')).statusCode).toBe(201);
      }
      const before = (await ledgerOf(h, who)).length;
      const refusedKey = key();
      const refused = await buyFish(h, who, tank.id, 'angelfish', 'adult', refusedKey);
      expect(refused.statusCode).toBe(402);
      expect(errorCode(refused)).toBe('insufficient_pearls');
      expect(await balance(h, who)).toBe(149);
      expect(await ledgerOf(h, who)).toHaveLength(before);
      const read = tankSchema.parse((await call(h, who, 'GET', `/api/tanks/${tank.id}`)).json());
      expect(read.fish.filter((f) => f.species === 'angelfish')).toHaveLength(2);

      await setBalance(h, who, 150);
      expect((await buyFish(h, who, tank.id, 'angelfish', 'adult', refusedKey)).statusCode).toBe(
        201,
      );
      expect(await balance(h, who)).toBe(0);
    });

    it('lets only one of two racing purchases through when the balance covers one', async () => {
      const { who, tank } = await primed(h);
      const quarantine = await createTank(h, who, { size: 'nano30', quarantine: true });
      expect(quarantine.statusCode).toBe(201);
      const second = tankSchema.parse(quarantine.json());
      await setBalance(h, who, 150);

      const results = await Promise.all([
        buyFish(h, who, tank.id, 'angelfish', 'adult'),
        buyFish(h, who, second.id, 'angelfish', 'adult'),
      ]);
      expect(results.map((r) => r.statusCode).toSorted()).toEqual([201, 402]);
      expect(await balance(h, who)).toBe(0);
      expect(await sumLedger(h, who)).toBe(0);
    });

    it('charges once for concurrent duplicates of one request', async () => {
      const { who, tank } = await primed(h);
      const before = await balance(h, who);
      const duplicate = key();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => buyFish(h, who, tank.id, 'guppy', 'juvenile', duplicate)),
      );
      expect(results.map((r) => r.statusCode).toSorted()).toEqual([200, 200, 200, 200, 201]);
      const guppies = tankSchema
        .parse((await call(h, who, 'GET', `/api/tanks/${tank.id}`)).json())
        .fish.filter((f) => f.species === 'guppy');
      expect(guppies).toHaveLength(1);
      expect(await balance(h, who)).toBe(before - (economy.species['guppy']?.juvenile ?? 0));
    });

    it('answers a replay with the tank and a reused key for another item with 409', async () => {
      const { who, tank } = await primed(h);
      const first = key();
      expect((await buyFish(h, who, tank.id, 'guppy', 'juvenile', first)).statusCode).toBe(201);
      const before = await balance(h, who);

      const replay = await buyFish(h, who, tank.id, 'guppy', 'juvenile', first);
      expect(replay.statusCode).toBe(200);
      expect(
        tankSchema.parse(replay.json()).fish.filter((f) => f.species === 'guppy'),
      ).toHaveLength(1);

      for (const [species, stage] of [
        ['guppy', 'adult'],
        ['neon-tetra', 'juvenile'],
      ] as const) {
        const clash = await buyFish(h, who, tank.id, species, stage, first);
        expect(clash.statusCode).toBe(409);
        expect(errorCode(clash)).toBe('conflict');
      }
      expect(await balance(h, who)).toBe(before);
    });

    it('refuses a fish for the wrong biome before charging', async () => {
      const { who, tank } = await primed(h);
      const before = await balance(h, who);
      expect((await buyFish(h, who, tank.id, 'blue-tang', 'adult')).statusCode).toBe(400);
      expect(await balance(h, who)).toBe(before);
    });

    it('sells the silver mono only for a tank at least 150 cm long', async () => {
      const who = await account(h);
      await setBalance(h, who, 10_000);
      const standard = tankSchema.parse((await createTank(h, who, { biome: 'mangrove' })).json());
      const before = await balance(h, who);
      const refused = await buyFish(h, who, standard.id, 'silver-mono', 'juvenile');
      expect(refused.statusCode).toBe(400);
      expect(errorCode(refused)).toBe('validation_failed');
      expect(await balance(h, who)).toBe(before);

      const long = tankSchema.parse(
        (await createTank(h, who, { biome: 'mangrove', size: 'long300' })).json(),
      );
      expect((await buyFish(h, who, long.id, 'silver-mono', 'juvenile')).statusCode).toBe(201);

      const quarantine = tankSchema.parse(
        (await createTank(h, who, { biome: 'mangrove', size: 'nano30', quarantine: true })).json(),
      );
      expect((await buyFish(h, who, quarantine.id, 'silver-mono', 'juvenile')).statusCode).toBe(
        201,
      );
    });

    it('grows a bought juvenile of a species with no fry timeline into an adult', async () => {
      const { who, tank } = await primed(h);
      const catalog = loadCatalog().get('neon-tetra');
      if (!catalog) throw new Error('neon-tetra missing');
      await setBalance(h, who, 500);
      const bought = tankSchema.parse(
        (await buyFish(h, who, tank.id, 'neon-tetra', 'juvenile')).json(),
      );
      const id = bought.fish.at(-1)?.id;
      expect(id).toBeDefined();
      await h.database.db
        .update(schema.fish)
        .set({ size: catalog.lifecycle.maxSizeM * 0.9 })
        .where(eq(schema.fish.id, id ?? ''));
      h.clock.advance(60 * 60_000);
      const read = tankSchema.parse((await call(h, who, 'GET', `/api/tanks/${tank.id}`)).json());
      expect(read.fish.find((f) => f.id === id)?.stage).toBe('adult');
    });
  });

  describe('tanks', () => {
    it('prices the second tank by slot and the size by upgrade, and keeps the first free', async () => {
      const who = await account(h);
      const first = await createTank(h, who);
      expect(first.statusCode).toBe(201);
      expect(await balance(h, who)).toBe(economy.grants.starting);

      const slot = economy.items.tankSlots[0] ?? 0;
      const second = await createTank(h, who, { key: key() });
      expect(second.statusCode).toBe(201);
      expect(await balance(h, who)).toBe(economy.grants.starting - slot);

      const poor = await createTank(h, who, { key: key() });
      expect(poor.statusCode).toBe(402);
      expect(errorCode(poor)).toBe('insufficient_pearls');
      const owned = await h.database.db
        .select()
        .from(schema.tanks)
        .where(eq(schema.tanks.ownerId, who.userId));
      expect(owned).toHaveLength(2);
    });

    it('adds the size upgrade to a tank price', async () => {
      const who = await account(h);
      const nano = await createTank(h, who, { size: 'nano30', key: key() });
      expect(nano.statusCode).toBe(201);
      expect(await balance(h, who)).toBe(
        economy.grants.starting - (economy.items.tankSizes.nano30 ?? 0),
      );
    });

    it('replays a tank purchase and rejects its key for another size', async () => {
      const who = await account(h);
      await freeTank(h, who);
      const k = key();
      const created = await createTank(h, who, { key: k });
      expect(created.statusCode).toBe(201);
      const afterFirst = await balance(h, who);

      const replay = await createTank(h, who, { key: k });
      expect(replay.statusCode).toBe(200);
      expect(tankSchema.parse(replay.json()).id).toBe(tankSchema.parse(created.json()).id);
      expect(await balance(h, who)).toBe(afterFirst);

      const other = await createTank(h, who, { size: 'nano30', key: k });
      expect(other.statusCode).toBe(409);
      const owned = await h.database.db
        .select()
        .from(schema.tanks)
        .where(eq(schema.tanks.ownerId, who.userId));
      expect(owned).toHaveLength(2);
    });

    it('replays the free first tank without charging for a second one', async () => {
      const who = await account(h);
      const k = key();
      const first = await createTank(h, who, { key: k });
      expect(first.statusCode).toBe(201);
      const replay = await createTank(h, who, { key: k });
      expect(replay.statusCode).toBe(200);
      expect(tankSchema.parse(replay.json()).id).toBe(tankSchema.parse(first.json()).id);
      expect(await balance(h, who)).toBe(economy.grants.starting);
      const owned = await h.database.db
        .select()
        .from(schema.tanks)
        .where(eq(schema.tanks.ownerId, who.userId));
      expect(owned).toHaveLength(1);
      expect((await createTank(h, who, { size: 'nano30', key: k })).statusCode).toBe(409);
    });

    it('keeps the quarantine tank free', async () => {
      const who = await account(h);
      await freeTank(h, who);
      const res = await createTank(h, who, { size: 'nano30', quarantine: true });
      expect(res.statusCode).toBe(201);
      expect(await balance(h, who)).toBe(economy.grants.starting);
    });
  });

  describe('shop purchases', () => {
    it('sells a background once, unlocks it for every tank and applies it on request', async () => {
      const who = await account(h);
      const tank = await freeTank(h, who);
      const locked = await call(h, who, 'PATCH', `/api/tanks/${tank.id}`, {
        backgroundId: 'bg-fw-root-tangle',
      });
      expect(locked.statusCode).toBe(403);
      expect(errorCode(locked)).toBe('forbidden');

      const bought = await purchase(h, who, 'background:bg-fw-root-tangle');
      expect(bought.statusCode).toBe(200);
      const body = purchaseResponseSchema.parse(bought.json());
      expect(body.replayed).toBe(false);
      expect(body.entry.delta).toBe(-economy.items.background.price);
      expect(body.wallet.balance).toBe(economy.grants.starting - economy.items.background.price);

      expect((await purchase(h, who, 'background:bg-fw-root-tangle')).statusCode).toBe(409);
      const applied = await call(h, who, 'PATCH', `/api/tanks/${tank.id}`, {
        backgroundId: 'bg-fw-root-tangle',
      });
      expect(applied.statusCode).toBe(200);
      expect(await balance(h, who)).toBe(economy.grants.starting - economy.items.background.price);
    });

    it('applies a purchased background to the tank it names and never charges a free one', async () => {
      const who = await account(h);
      const tank = await freeTank(h, who);
      const bought = await purchase(h, who, 'background:bg-fw-plant-wall', tank.id);
      expect(bought.statusCode).toBe(200);
      const read = tankSchema.parse((await call(h, who, 'GET', `/api/tanks/${tank.id}`)).json());
      expect(read.backgroundId).toBe('bg-fw-plant-wall');
      const free = await purchase(h, who, 'background:bg-fw-planted-stream');
      expect(free.statusCode).toBe(400);
      const back = await call(h, who, 'PATCH', `/api/tanks/${tank.id}`, {
        backgroundId: 'bg-fw-planted-stream',
      });
      expect(back.statusCode).toBe(200);
    });

    it('replays a purchase with the stored entry and charges nothing more', async () => {
      const who = await account(h);
      const k = key();
      const first = purchaseResponseSchema.parse(
        (await purchase(h, who, 'background:bg-fw-misty-lake', undefined, k)).json(),
      );
      const second = await purchase(h, who, 'background:bg-fw-misty-lake', undefined, k);
      expect(second.statusCode).toBe(200);
      const replay = purchaseResponseSchema.parse(second.json());
      expect(replay.replayed).toBe(true);
      expect(replay.entry.id).toBe(first.entry.id);
      expect(replay.wallet.balance).toBe(first.wallet.balance);

      const clash = await purchase(h, who, 'background:bg-fw-root-tangle', undefined, k);
      expect(clash.statusCode).toBe(409);
      expect(await balance(h, who)).toBe(first.wallet.balance);
    });

    it('refuses to spend more than the balance on an item', async () => {
      const who = await account(h);
      await setBalance(h, who, economy.items.background.price - 1);
      const res = await purchase(h, who, 'background:bg-fw-misty-lake');
      expect(res.statusCode).toBe(402);
      expect(await balance(h, who)).toBe(economy.items.background.price - 1);
      expect(await sumLedger(h, who)).toBe(economy.items.background.price - 1);
    });

    it('upgrades equipment by tier and refuses a tier it already has', async () => {
      const { who, tank } = await primed(h);
      const [, tier2, tier3] = economy.items.equipment.heater;
      const before = await balance(h, who);
      const res = await purchase(h, who, 'equipment:heater:2', tank.id);
      expect(res.statusCode).toBe(200);
      expect(await balance(h, who)).toBe(before - (tier2 ?? 0));
      const read = tankSchema.parse((await call(h, who, 'GET', `/api/tanks/${tank.id}`)).json());
      expect(read.equipment.heater.tier).toBe(2);

      expect((await purchase(h, who, 'equipment:heater:2', tank.id)).statusCode).toBe(409);
      expect((await purchase(h, who, 'equipment:heater:1', tank.id)).statusCode).toBe(409);
      expect((await purchase(h, who, 'equipment:heater:4', tank.id)).statusCode).toBe(400);
      expect((await purchase(h, who, 'equipment:heater:2')).statusCode).toBe(400);
      await setBalance(h, who, tier3 ?? 0);
      expect((await purchase(h, who, 'equipment:heater:3', tank.id)).statusCode).toBe(200);
    });

    it('lowers CO2, turns it off and restores an owned tier without charging', async () => {
      const { who, tank } = await primed(h);
      const [tier1, tier2] = economy.items.equipment.co2;
      await setBalance(h, who, (tier1 ?? 0) + (tier2 ?? 0));
      expect((await purchase(h, who, 'equipment:co2:1', tank.id)).statusCode).toBe(200);
      expect((await purchase(h, who, 'equipment:co2:2', tank.id)).statusCode).toBe(200);
      const paid = await balance(h, who);
      const ledgerRows = (await ledgerOf(h, who)).length;
      const setCo2 = async (tier: number) => {
        const res = await call(h, who, 'PATCH', `/api/tanks/${tank.id}`, { co2: { tier } });
        return {
          res,
          tier: res.statusCode === 200 ? tankSchema.parse(res.json()).equipment.co2.tier : null,
        };
      };

      expect((await setCo2(1)).tier).toBe(1);
      expect((await setCo2(0)).tier).toBe(0);
      expect((await setCo2(2)).tier).toBe(2);
      const above = await setCo2(3);
      expect(above.res.statusCode).toBe(400);
      expect(errorCode(above.res)).toBe('validation_failed');
      expect((await setCo2(2)).tier).toBe(2);
      expect(await balance(h, who)).toBe(paid);
      expect((await ledgerOf(h, who)).length).toBe(ledgerRows);
      expect((await purchase(h, who, 'equipment:co2:1', tank.id)).statusCode).toBe(409);
      expect((await setCo2(0)).tier).toBe(0);
      expect((await purchase(h, who, 'equipment:co2:1', tank.id)).statusCode).toBe(409);
      expect((await purchase(h, who, 'equipment:co2:2', tank.id)).statusCode).toBe(409);
      expect(await balance(h, who)).toBe(paid);
      expect((await ledgerOf(h, who)).length).toBe(ledgerRows);
    });

    it('keeps an owned CO2 tier with the tank that bought it', async () => {
      const { who, tank } = await primed(h);
      await setBalance(h, who, economy.items.equipment.co2[0] ?? 0);
      expect((await purchase(h, who, 'equipment:co2:1', tank.id)).statusCode).toBe(200);
      await setBalance(h, who, economy.items.tankSlots[0] ?? 0);
      const other = await createTank(h, who, { biome: 'freshwater' });
      expect(other.statusCode).toBe(201);
      const otherId = tankSchema.parse(other.json()).id;
      const res = await call(h, who, 'PATCH', `/api/tanks/${otherId}`, { co2: { tier: 1 } });
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe('validation_failed');
    });

    it('never runs CO2 in a biome that cannot use it', async () => {
      const who = await account(h);
      const tank = tankSchema.parse((await createTank(h, who, { biome: 'reef' })).json());
      const res = await call(h, who, 'PATCH', `/api/tanks/${tank.id}`, { co2: { tier: 1 } });
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe('validation_failed');
    });

    it('refuses an equipment upgrade the balance cannot cover, changing nothing', async () => {
      const { who, tank } = await primed(h);
      const [, tier2] = economy.items.equipment.heater;
      await setBalance(h, who, (tier2 ?? 0) - 1);
      const res = await purchase(h, who, 'equipment:heater:2', tank.id);
      expect(res.statusCode).toBe(402);
      expect(await balance(h, who)).toBe((tier2 ?? 0) - 1);
      expect(await sumLedger(h, who)).toBe((tier2 ?? 0) - 1);
      const read = tankSchema.parse((await call(h, who, 'GET', `/api/tanks/${tank.id}`)).json());
      expect(read.equipment.heater.tier).toBe(1);
    });

    it('replays an equipment purchase by key, charges once and refuses the key for another tier', async () => {
      const { who, tank } = await primed(h);
      const [, tier2] = economy.items.equipment.filter;
      const before = await balance(h, who);
      const k = key();
      const first = purchaseResponseSchema.parse(
        (await purchase(h, who, 'equipment:filter:2', tank.id, k)).json(),
      );
      const again = purchaseResponseSchema.parse(
        (await purchase(h, who, 'equipment:filter:2', tank.id, k)).json(),
      );
      expect(first.replayed).toBe(false);
      expect(again.replayed).toBe(true);
      expect(again.entry.id).toBe(first.entry.id);
      expect(await balance(h, who)).toBe(before - (tier2 ?? 0));
      const clash = await purchase(h, who, 'equipment:filter:3', tank.id, k);
      expect(clash.statusCode).toBe(409);
      expect(await balance(h, who)).toBe(before - (tier2 ?? 0));
    });

    it('charges only the tier bought when skipping a tier, never refunds a downgrade', async () => {
      const { who, tank } = await primed(h);
      const [, , tier3] = economy.items.equipment.light;
      await setBalance(h, who, (tier3 ?? 0) + 100);
      const before = await balance(h, who);
      expect((await purchase(h, who, 'equipment:light:3', tank.id)).statusCode).toBe(200);
      expect(await balance(h, who)).toBe(before - (tier3 ?? 0));
      expect((await purchase(h, who, 'equipment:light:2', tank.id)).statusCode).toBe(409);
      expect(await balance(h, who)).toBe(before - (tier3 ?? 0));
      const read = tankSchema.parse((await call(h, who, 'GET', `/api/tanks/${tank.id}`)).json());
      expect(read.equipment.light).toMatchObject({ tier: 3, intensity: 0.8 });
    });

    it('keeps the lamp schedule when a better lamp is bought and refuses a wave maker in fresh water', async () => {
      const { who, tank } = await primed(h);
      const set = await call(h, who, 'PATCH', `/api/tanks/${tank.id}`, {
        light: { intensity: 0.5, onHour: 9, offHour: 17 },
      });
      expect(set.statusCode).toBe(200);
      await purchase(h, who, 'equipment:light:2', tank.id);
      const read = tankSchema.parse((await call(h, who, 'GET', `/api/tanks/${tank.id}`)).json());
      expect(read.equipment.light).toEqual({ tier: 2, intensity: 0.5, onHour: 9, offHour: 17 });
      expect((await purchase(h, who, 'equipment:waveMaker:1', tank.id)).statusCode).toBe(400);
    });

    it('refuses a device that does not belong in the tank biome before charging', async () => {
      const who = await account(h);
      const reef = await freeTank(h, who, 'reef');
      const before = await balance(h, who);
      expect((await purchase(h, who, 'equipment:co2:1', reef.id)).statusCode).toBe(400);
      expect(await balance(h, who)).toBe(before);
    });

    it('refuses CO2 for a blackwater tank, and a leftover CO2 unit never blocks other upgrades', async () => {
      const who = await account(h);
      const tank = await freeTank(h, who, 'blackwater');
      await setBalance(h, who, 5000);
      expect((await purchase(h, who, 'equipment:co2:1', tank.id)).statusCode).toBe(400);
      expect(await balance(h, who)).toBe(5000);

      await h.database.pool.query(
        `update tanks set equipment = jsonb_set(equipment, '{co2,tier}', '2') where id = $1`,
        [tank.id],
      );
      const res = await purchase(h, who, 'equipment:heater:2', tank.id);
      expect(res.statusCode).toBe(200);
      const read = tankSchema.parse((await call(h, who, 'GET', `/api/tanks/${tank.id}`)).json());
      expect(read.equipment.heater.tier).toBe(2);
      expect(read.equipment.co2.tier).toBe(2);
      expect((await purchase(h, who, 'equipment:co2:2', tank.id)).statusCode).toBe(409);
    });

    it('licenses plants and decor, charged once and checked against the saved layout', async () => {
      const { who, tank } = await primed(h);
      const piece = (assetId: string) => ({ assetId, position: [0, 0.05, 0] });
      const feeder = piece('vacation-feeder');
      const save = (layout: object[]) =>
        call(h, who, 'PATCH', `/api/tanks/${tank.id}`, { decorLayout: layout });

      expect((await save([feeder])).statusCode).toBe(200);
      const locked = await save([feeder, piece('java-fern')]);
      expect(locked.statusCode).toBe(403);
      expect(errorCode(locked)).toBe('forbidden');

      const reefOnly = await purchase(h, who, 'decor:reef-arch', tank.id);
      expect(reefOnly.statusCode).toBe(400);

      const before = await balance(h, who);
      expect((await purchase(h, who, 'plant:java-fern', tank.id)).statusCode).toBe(200);
      expect(await balance(h, who)).toBe(before - (economy.items.plant.prices['java-fern'] ?? 0));
      expect((await purchase(h, who, 'plant:java-fern', tank.id)).statusCode).toBe(409);

      expect((await save([feeder, piece('java-fern'), piece('java-fern')])).statusCode).toBe(200);
      expect((await save([feeder])).statusCode).toBe(200);
      expect((await save([feeder, piece('java-fern')])).statusCode).toBe(200);
      expect((await save([feeder, piece('java-fern'), piece('vallisneria')])).statusCode).toBe(403);
    });

    it('licence-checks the first save of a tank that still shows the preset', async () => {
      const { who, tank } = await primed(h);
      const preset = presets.freshwater;
      if (!preset) throw new Error('freshwater preset missing');
      const save = (layout: object[]) =>
        call(h, who, 'PATCH', `/api/tanks/${tank.id}`, { decorLayout: layout });

      const locked = await save([
        ...preset.decor,
        { assetId: 'vallisneria', position: [0, 0.05, 0] },
      ]);
      expect(locked.statusCode).toBe(403);
      expect(errorCode(locked)).toBe('forbidden');
      expect((await save(preset.decor)).statusCode).toBe(200);
      expect((await save(preset.decor.slice(0, 3))).statusCode).toBe(200);
    });

    it('charges a copy added beyond what the preset shows', async () => {
      const { who, tank } = await primed(h);
      const preset = presets.freshwater;
      if (!preset) throw new Error('freshwater preset missing');
      const extra = { assetId: 'java-fern', position: [0.1, 0.05, 0] };
      const save = () =>
        call(h, who, 'PATCH', `/api/tanks/${tank.id}`, {
          decorLayout: [...preset.decor, extra],
        });
      expect((await save()).statusCode).toBe(403);
      const before = await balance(h, who);
      expect((await purchase(h, who, 'plant:java-fern', tank.id)).statusCode).toBe(200);
      const fernPrice = economy.items.plant.prices['java-fern'];
      if (!fernPrice) throw new Error('java-fern has no price in the economy');
      expect(await balance(h, who)).toBe(before - fernPrice);
      expect((await save()).statusCode).toBe(200);
    });

    it('saves the unpriced mud bank over an old mangrove layout, and holds it to one', async () => {
      const who = await account(h);
      const tank = tankSchema.parse((await createTank(h, who, { biome: 'mangrove' })).json());
      const preset = presets.mangrove;
      if (!preset) throw new Error('mangrove preset missing');
      const bank = preset.decor.find((item) => item.assetId === 'mud-bank');
      if (!bank) throw new Error('mangrove preset has no mud bank');
      const rest = preset.decor.filter((item) => item.assetId !== 'mud-bank');
      const save = (layout: object[]) =>
        call(h, who, 'PATCH', `/api/tanks/${tank.id}`, { decorLayout: layout });

      expect((await save(rest)).statusCode).toBe(200);
      expect((await save(preset.decor)).statusCode).toBe(200);
      const two = await save([...preset.decor, bank]);
      expect(two.statusCode).toBe(400);
      expect(errorCode(two)).toBe('validation_failed');
    });

    it('rejects a mud bank scaled outside its range', async () => {
      const who = await account(h);
      const tank = tankSchema.parse((await createTank(h, who, { biome: 'mangrove' })).json());
      const bank = presets.mangrove?.decor.find((item) => item.assetId === 'mud-bank');
      if (!bank) throw new Error('mangrove preset has no mud bank');
      const save = (scale: number) =>
        call(h, who, 'PATCH', `/api/tanks/${tank.id}`, { decorLayout: [{ ...bank, scale }] });

      expect((await save(2.5)).statusCode).toBe(200);
      for (const scale of [0.1, 10]) {
        const res = await save(scale);
        expect(res.statusCode, `${scale}`).toBe(400);
        expect(errorCode(res)).toBe('validation_failed');
      }
    });

    it('shares one licence between every procedural euphyllia piece', async () => {
      const who = await account(h);
      const reef = await freeTank(h, who, 'reef');
      const piece = (assetId: string) => ({ assetId, position: [0, 0.05, 0] });
      const save = (layout: object[]) =>
        call(h, who, 'PATCH', `/api/tanks/${reef.id}`, { decorLayout: layout });
      expect((await save([piece('vacation-feeder')])).statusCode).toBe(200);
      expect((await save([piece('euphyllia-hammer-3')])).statusCode).toBe(403);
      const before = await balance(h, who);
      expect((await purchase(h, who, 'decor:euphyllia', reef.id)).statusCode).toBe(200);
      expect(await balance(h, who)).toBe(before - economy.items.euphyllia);
      expect(
        (await save([piece('euphyllia-hammer-3'), piece('euphyllia-torch-17')])).statusCode,
      ).toBe(200);
    });

    it('does not sell fish, tanks, unpriced consumables or unknown items here', async () => {
      const { who, tank } = await primed(h);
      const before = await balance(h, who);
      for (const itemRef of [
        'species:neon-tetra:adult',
        `tank:standard:${randomUUID()}`,
        'consumable:bottled-bacteria',
        'consumable:test-kit',
        'pack:pearls-550',
        'plant:no-such-plant',
        'decor:euphyllia-hammer-3',
        'background:bg-nope',
        '__proto__',
      ]) {
        const res = await purchase(h, who, itemRef, tank.id);
        expect(res.statusCode, itemRef).toBe(400);
      }
      expect(await balance(h, who)).toBe(before);
    });
  });

  describe('free care', () => {
    const feed = (who: Account, tankId: string) =>
      call(h, who, 'POST', `/api/tanks/${tankId}/care`, {
        type: 'feed',
        food: 'flakes',
        portion: 0.5,
      });
    const care = (who: Account, tankId: string, type: string) =>
      call(h, who, 'POST', `/api/tanks/${tankId}/care`, { type });

    it.each([0, -75])('is never blocked or charged at a balance of %i', async (start) => {
      const { who, tank } = await primed(h);
      await setBalance(h, who, start);
      for (const res of [
        await feed(who, tank.id),
        await care(who, tank.id, 'water_change'),
        await care(who, tank.id, 'gravel_vacuum'),
        await care(who, tank.id, 'algae_scrape'),
        await care(who, tank.id, 'filter_rinse'),
      ]) {
        expect(res.statusCode).toBe(200);
      }
      const charged = (await ledgerOf(h, who)).filter(
        (r) => r.reason === 'purchase' && r.itemRef !== 'species:neon-tetra:juvenile',
      );
      expect(charged).toEqual([]);
      expect(await balance(h, who)).toBeGreaterThanOrEqual(start);
    });

    it('charges bottled bacteria once per key and applies it once', async () => {
      const { who, tank } = await primed(h);
      const bacteria = (body: object) =>
        call(h, who, 'POST', `/api/tanks/${tank.id}/care`, { type: 'bottled_bacteria', ...body });
      const before = await balance(h, who);
      const k = key();
      expect((await bacteria({ idempotencyKey: k })).statusCode).toBe(200);
      expect((await bacteria({ idempotencyKey: k })).statusCode).toBe(200);
      expect(await balance(h, who)).toBe(before - economy.items.consumables.bottledBacteria);
      const events = await h.database.db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.tankId, tank.id), eq(schema.events.kind, 'bottled_bacteria')));
      expect(events).toHaveLength(1);
    });

    it('refuses bottled bacteria the user cannot afford and leaves the tank untouched', async () => {
      const { who, tank } = await primed(h);
      await setBalance(h, who, economy.items.consumables.bottledBacteria - 1);
      const res = await call(h, who, 'POST', `/api/tanks/${tank.id}/care`, {
        type: 'bottled_bacteria',
        idempotencyKey: key(),
      });
      expect(res.statusCode).toBe(402);
      const events = await h.database.db
        .select()
        .from(schema.events)
        .where(eq(schema.events.tankId, tank.id));
      expect(events.map((e) => e.kind)).not.toContain('bottled_bacteria');
    });
  });

  describe.each([
    ['buffer_dose', 'bufferDose', 'blackwater'],
    ['add_botanicals', 'botanicals', 'reef'],
  ] as const)('%s', (type, price, refusedBiome) => {
    it('charges once per key, applies once and logs one event', async () => {
      const { who, tank } = await primed(h);
      const dose = (k: string) =>
        call(h, who, 'POST', `/api/tanks/${tank.id}/care`, { type, idempotencyKey: k });
      const before = await balance(h, who);
      const k = key();
      expect((await dose(k)).statusCode).toBe(200);
      const once = await call(h, who, 'GET', `/api/tanks/${tank.id}`);
      expect((await dose(k)).statusCode).toBe(200);
      const twice = await call(h, who, 'GET', `/api/tanks/${tank.id}`);
      expect(twice.json().chemistry).toEqual(once.json().chemistry);
      expect(await balance(h, who)).toBe(before - economy.items.consumables[price]);
      const events = await h.database.db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.tankId, tank.id), eq(schema.events.kind, type)));
      expect(events).toHaveLength(1);
    });

    it('402s when the user cannot afford it', async () => {
      const { who, tank } = await primed(h);
      await setBalance(h, who, economy.items.consumables[price] - 1);
      const res = await call(h, who, 'POST', `/api/tanks/${tank.id}/care`, {
        type,
        idempotencyKey: key(),
      });
      expect(res.statusCode).toBe(402);
    });

    it(`refuses in a ${refusedBiome} tank before looking at the balance`, async () => {
      const { who } = await primed(h);
      const made = await createTank(h, who, { biome: refusedBiome });
      await setBalance(h, who, 0);
      const rows = (await ledgerOf(h, who)).length;
      const res = await call(h, who, 'POST', `/api/tanks/${made.json().id}/care`, {
        type,
        idempotencyKey: key(),
      });
      expect(res.statusCode).toBe(422);
      expect(await ledgerOf(h, who)).toHaveLength(rows);
    });

    it(`422s in a ${refusedBiome} tank without charging`, async () => {
      const { who } = await primed(h);
      const made = await createTank(h, who, { biome: refusedBiome });
      expect(made.statusCode).toBe(201);
      const before = await balance(h, who);
      const res = await call(h, who, 'POST', `/api/tanks/${made.json().id}/care`, {
        type,
        idempotencyKey: key(),
      });
      expect(res.statusCode).toBe(422);
      expect(await balance(h, who)).toBe(before);
    });
  });

  it('keeps server reward keys out of the namespace a client can send', async () => {
    const { who } = await primed(h);
    const rewards = (await ledgerOf(h, who)).filter(
      (r) => r.reason === 'earn' || r.reason === 'grant',
    );
    expect(rewards.length).toBeGreaterThan(0);
    for (const row of rewards) {
      if (row.idempotencyKey === 'grant-migration') continue;
      expect(row.idempotencyKey.startsWith('server:')).toBe(true);
      expect(idempotencyKeySchema.safeParse(row.idempotencyKey).success).toBe(false);
    }
  });

  it('limits the wallet and the shop per user', async () => {
    const limited = await createHarness({
      careLimits: {
        ...DEFAULT_CARE_LIMITS,
        wallet: { max: 2, windowMs: 60_000 },
        purchase: { max: 2, windowMs: 60_000 },
      },
    });
    try {
      const who = await account(limited);
      expect((await call(limited, who, 'GET', '/api/wallet')).statusCode).toBe(200);
      expect((await call(limited, who, 'GET', '/api/wallet')).statusCode).toBe(200);
      expect((await call(limited, who, 'GET', '/api/wallet')).statusCode).toBe(429);
      expect((await purchase(limited, who, 'background:bg-fw-misty-lake')).statusCode).toBe(200);
      expect((await purchase(limited, who, 'background:bg-fw-root-tangle')).statusCode).toBe(200);
      expect((await purchase(limited, who, 'background:bg-fw-plant-wall')).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe('requests from a client that predates the shop (#765)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const legacyFish = (who: Account, tankId: string, extra: Record<string, unknown> = {}) =>
    call(h, who, 'POST', `/api/tanks/${tankId}/fish`, {
      species: 'angelfish',
      name: 'Old',
      ...extra,
    });

  it.each([
    ['stage', { idempotencyKey: key() }],
    ['idempotencyKey', { stage: 'adult' }],
  ])('rejects a fish sent without %s and charges nothing', async (field, extra) => {
    const { who, tank } = await primed(h);
    const before = await balance(h, who);
    const ledgerBefore = (await ledgerOf(h, who)).length;
    const res = await legacyFish(who, tank.id, extra);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain(field);
    expect(await balance(h, who)).toBe(before);
    expect(await ledgerOf(h, who)).toHaveLength(ledgerBefore);
  });

  it('refuses a fish it cannot pay for with 402 and no trace', async () => {
    const { who, tank } = await primed(h);
    await setBalance(h, who, (economy.species['angelfish']?.adult ?? 0) - 1);
    const before = (await ledgerOf(h, who)).length;
    const res = await legacyFish(who, tank.id, { stage: 'adult', idempotencyKey: key() });
    expect(res.statusCode).toBe(402);
    expect(errorCode(res)).toBe('insufficient_pearls');
    expect(await ledgerOf(h, who)).toHaveLength(before);
    const read = tankSchema.parse((await call(h, who, 'GET', `/api/tanks/${tank.id}`)).json());
    expect(read.fish.some((f) => f.species === 'angelfish')).toBe(false);
  });

  it('charges the slot price for a second tank, and 402s on overdraft', async () => {
    const who = await account(h);
    expect((await createTank(h, who)).statusCode).toBe(201);
    expect(await balance(h, who)).toBe(economy.grants.starting);
    const second = await createTank(h, who);
    expect(second.statusCode).toBe(201);
    const slot = economy.items.tankSlots[0] ?? 0;
    expect(await balance(h, who)).toBe(economy.grants.starting - slot);
    const poor = await createTank(h, who);
    expect(poor.statusCode).toBe(402);
    const owned = await h.database.db
      .select()
      .from(schema.tanks)
      .where(eq(schema.tanks.ownerId, who.userId));
    expect(owned).toHaveLength(2);
  });

  it('opens the wallet itself when a paid tank is the first thing an account does', async () => {
    const who = await account(h);
    expect((await createTank(h, who)).statusCode).toBe(201);
    expect((await createTank(h, who)).statusCode).toBe(201);
    const slot = economy.items.tankSlots[0] ?? 0;
    expect(await balance(h, who)).toBe(economy.grants.starting - slot);
  });

  it('charges bottled bacteria, and 402s on overdraft', async () => {
    const { who, tank } = await primed(h);
    const bacteria = () =>
      call(h, who, 'POST', `/api/tanks/${tank.id}/care`, {
        type: 'bottled_bacteria',
        idempotencyKey: key(),
      });
    const price = economy.items.consumables.bottledBacteria;
    await setBalance(h, who, price);
    expect((await bacteria()).statusCode).toBe(200);
    expect(await balance(h, who)).toBe(0);
    const refused = await bacteria();
    expect(refused.statusCode).toBe(402);
    expect(errorCode(refused)).toBe('insufficient_pearls');
    expect(await balance(h, who)).toBe(0);
  });

  it('rejects bottled bacteria sent without idempotencyKey and charges nothing', async () => {
    const { who, tank } = await primed(h);
    const before = await balance(h, who);
    const ledgerBefore = (await ledgerOf(h, who)).length;
    const res = await call(h, who, 'POST', `/api/tanks/${tank.id}/care`, {
      type: 'bottled_bacteria',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('idempotencyKey');
    expect(await balance(h, who)).toBe(before);
    expect(await ledgerOf(h, who)).toHaveLength(ledgerBefore);
    const events = await h.database.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.tankId, tank.id), eq(schema.events.kind, 'bottled_bacteria')));
    expect(events).toHaveLength(0);
  });

  it('rejects a tank sent without idempotencyKey and creates and charges nothing', async () => {
    const who = await account(h);
    expect((await createTank(h, who)).statusCode).toBe(201);
    const before = await balance(h, who);
    const ledgerBefore = (await ledgerOf(h, who)).length;
    const res = await call(h, who, 'POST', '/api/tanks', { name: 'Second', biome: 'freshwater' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('idempotencyKey');
    expect(await balance(h, who)).toBe(before);
    expect(await ledgerOf(h, who)).toHaveLength(ledgerBefore);
    const owned = await h.database.db
      .select()
      .from(schema.tanks)
      .where(eq(schema.tanks.ownerId, who.userId));
    expect(owned).toHaveLength(1);
  });
});

describe('earning Pearls', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    h.clock.advance(DAY_MS - (h.clock.now() % DAY_MS) + 3_600_000);
  });
  afterEach(() => h.close());

  const earned = async (who: Account, prefix: string) => {
    const [row] = await h.database.db
      .select({ total: sql<number>`coalesce(sum(${schema.ledger.delta}), 0)::int` })
      .from(schema.ledger)
      .where(
        and(
          eq(schema.ledger.userId, who.userId),
          eq(schema.ledger.reason, 'earn'),
          like(schema.ledger.itemRef, `${prefix}%`),
        ),
      );
    return row?.total ?? 0;
  };
  const feed = (who: Account, tankId: string) =>
    call(h, who, 'POST', `/api/tanks/${tankId}/care`, {
      type: 'feed',
      food: 'flakes',
      portion: 0.5,
    });
  const care = (who: Account, tankId: string, type: string) =>
    call(h, who, 'POST', `/api/tanks/${tankId}/care`, { type });

  it('pays daily care once a day, topped up by feeding and upkeep, within the daily cap', async () => {
    const { who, tank } = await primed(h);
    const { reward, dailyCap } = economy.earn.dailyCare;
    expect((await feed(who, tank.id)).statusCode).toBe(200);
    expect(await earned(who, 'earn:daily-care')).toBe(reward.min);
    expect((await feed(who, tank.id)).statusCode).toBe(200);
    expect(await earned(who, 'earn:daily-care')).toBe(reward.min);
    expect((await care(who, tank.id, 'water_change')).statusCode).toBe(200);
    expect(await earned(who, 'earn:daily-care')).toBe(reward.max);
    expect((await care(who, tank.id, 'gravel_vacuum')).statusCode).toBe(200);
    expect((await feed(who, tank.id)).statusCode).toBe(200);
    expect(await earned(who, 'earn:daily-care')).toBeLessThanOrEqual(dailyCap);

    h.clock.advance(DAY_MS);
    expect((await care(who, tank.id, 'algae_scrape')).statusCode).toBe(200);
    expect(await earned(who, 'earn:daily-care')).toBe(reward.max + reward.min);
  });

  it('does not pay for a care action that the server refuses', async () => {
    const { who, tank } = await primed(h);
    const res = await call(h, who, 'POST', `/api/tanks/${tank.id}/care`, {
      type: 'feed',
      food: 'flakes',
      portion: 1000,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await earned(who, 'earn:daily-care')).toBe(0);
  });

  it('pays a healthy tank that was also cared for the day before, capped per account', async () => {
    const { who, tank } = await primed(h);
    await setBalance(h, who, 2_000);
    const other = tankSchema.parse((await createTank(h, who, { key: key() })).json());
    expect((await buyFish(h, who, other.id, 'guppy', 'juvenile')).statusCode).toBe(201);
    const { perDay, dailyCap } = economy.earn.healthyTankStreak;

    await care(who, tank.id, 'water_change');
    await care(who, other.id, 'water_change');
    expect(await earned(who, 'earn:streak:')).toBe(0);

    h.clock.advance(DAY_MS);
    await care(who, tank.id, 'water_change');
    expect(await earned(who, 'earn:streak:')).toBe(perDay);
    await care(who, other.id, 'water_change');
    expect(await earned(who, 'earn:streak:')).toBe(dailyCap);
    await care(who, tank.id, 'gravel_vacuum');
    expect(await earned(who, 'earn:streak:')).toBe(dailyCap);
  });

  it('pays no streak for a tank with a dead fish', async () => {
    const { who, tank } = await primed(h);
    await care(who, tank.id, 'water_change');
    await h.database.db
      .update(schema.fish)
      .set({ status: 'dead', diedAt: new Date(h.clock.now()), cause: 'starvation' })
      .where(eq(schema.fish.tankId, tank.id));
    h.clock.advance(DAY_MS);
    await care(who, tank.id, 'water_change');
    expect(await earned(who, 'earn:streak:')).toBe(0);
  });

  it('pays each achievement once and holds the rest back at the daily cap', async () => {
    const who = await account(h);
    const start = h.clock.now();
    await h.database.db.insert(schema.achievementAwards).values(
      ACHIEVEMENTS.map((a, i) => ({
        userId: who.userId,
        achievementId: a.id,
        earnedAt: new Date(start + i),
      })),
    );
    const cap = economy.earn.achievement.dailyCap;
    const paid = async () =>
      (await ledgerOf(h, who)).filter((r) => r.itemRef?.startsWith('earn:achievement:'));

    await walletOf(h, who);
    const firstDay = await earned(who, 'earn:achievement:');
    expect(firstDay).toBeGreaterThan(0);
    expect(firstDay).toBeLessThanOrEqual(cap);
    await walletOf(h, who);
    expect(await earned(who, 'earn:achievement:')).toBe(firstDay);

    for (
      let day = 0;
      day < ACHIEVEMENTS.length && (await paid()).length < ACHIEVEMENTS.length;
      day++
    ) {
      const before = await earned(who, 'earn:achievement:');
      h.clock.advance(DAY_MS);
      await walletOf(h, who);
      expect((await earned(who, 'earn:achievement:')) - before).toBeLessThanOrEqual(cap);
    }
    const rows = await paid();
    expect(rows).toHaveLength(ACHIEVEMENTS.length);
    expect(new Set(rows.map((r) => r.itemRef)).size).toBe(ACHIEVEMENTS.length);
    expect(await sumLedger(h, who)).toBe(await balance(h, who));
  });

  describe('selling fry', () => {
    const fry = async (tankId: string, species = 'discus', stage: 'fry' | 'adult' = 'fry') => {
      const id = randomUUID();
      await h.database.db.insert(schema.fish).values({
        id,
        tankId,
        species,
        name: 'Fry',
        size: 0.01,
        sex: 'female',
        stage,
        bornAt: new Date(h.clock.now()),
        personality: personalityFromFishId(id),
      });
      return id;
    };
    const sell = (who: Account, tankId: string, fishId: string) =>
      call(h, who, 'POST', `/api/tanks/${tankId}/fish/${fishId}/sell`);

    it('pays a share of the juvenile price, removes the fry and cannot be repeated', async () => {
      const { who, tank } = await primed(h);
      const id = await fry(tank.id);
      const before = await balance(h, who);
      const res = await sell(who, tank.id, id);
      expect(res.statusCode).toBe(200);
      const body = sellFryResponseSchema.parse(res.json());
      const juvenile = economy.species['discus']?.juvenile ?? 0;
      const amount = Math.floor((juvenile * economy.earn.frySale.percentOfJuvenilePrice) / 100);
      expect(body.entry).toMatchObject({
        delta: amount,
        reason: 'earn',
        itemRef: `earn:fry:${id}`,
      });
      expect(body.wallet.balance).toBe(before + amount);
      expect(body.tank.fish.some((f) => f.id === id)).toBe(false);
      expect((await sell(who, tank.id, id)).statusCode).toBe(404);
    });

    it('sells only living fry of the caller', async () => {
      const { who, tank } = await primed(h);
      const adult = await fry(tank.id, 'discus', 'adult');
      expect((await sell(who, tank.id, adult)).statusCode).toBe(409);
      const stranger = await account(h);
      const theirs = await freeTank(h, stranger);
      const theirFry = await fry(theirs.id);
      expect((await sell(who, theirs.id, theirFry)).statusCode).toBe(404);
      expect((await sell(who, tank.id, theirFry)).statusCode).toBe(404);
      const dead = await fry(tank.id);
      await h.database.db
        .update(schema.fish)
        .set({ status: 'dead', diedAt: new Date(h.clock.now()), cause: 'starvation' })
        .where(eq(schema.fish.id, dead));
      expect((await sell(who, tank.id, dead)).statusCode).toBe(409);
    });

    it('stops buying once the day is full and buys again the next day', async () => {
      const { who, tank } = await primed(h);
      const { dailyCap, percentOfJuvenilePrice } = economy.earn.frySale;
      const each = Math.floor(
        ((economy.species['discus']?.juvenile ?? 0) * percentOfJuvenilePrice) / 100,
      );
      const ids = await Promise.all(
        Array.from({ length: Math.ceil(dailyCap / each) + 1 }, () => fry(tank.id)),
      );
      let sold = 0;
      let refusedId: string | undefined;
      for (const id of ids) {
        const res = await sell(who, tank.id, id);
        if (res.statusCode === 200) sold += each;
        else {
          expect(res.statusCode).toBe(409);
          refusedId = id;
          break;
        }
      }
      expect(refusedId).toBeDefined();
      expect(sold).toBeLessThanOrEqual(dailyCap);
      expect(await earned(who, 'earn:fry:')).toBe(sold);

      h.clock.advance(DAY_MS);
      expect((await sell(who, tank.id, refusedId ?? '')).statusCode).toBe(200);
    });
  });
});

describe('export, deletion and retention', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const stripeKey = 'cs_test_retention_0001';
  const exportOf = async (who: Account) => {
    const res = await call(h, who, 'POST', '/api/me/export');
    expect(res.statusCode).toBe(200);
    return dataExportSchema.parse(res.json());
  };

  it('exports the wallet and every ledger row of the caller and nobody else', async () => {
    const { who } = await primed(h);
    const other = await primed(h);
    const data = await exportOf(who);
    expect(data.wallet.balance).toBe(await balance(h, who));
    const ids = data.wallet.ledger.map((r) => r['id']);
    expect(ids.toSorted()).toEqual((await ledgerOf(h, who)).map((r) => r.id).toSorted());
    const theirs = (await ledgerOf(h, other.who)).map((r) => r.id);
    expect(ids.filter((id) => theirs.includes(String(id)))).toEqual([]);
  });

  it('deletes play rows with the account and keeps real-money rows without the user', async () => {
    const { who, tank } = await primed(h);
    const bystander = await primed(h);
    await purchase(h, who, 'background:bg-fw-misty-lake', tank.id);
    await h.database.db.insert(schema.ledger).values({
      userId: who.userId,
      delta: 550,
      reason: 'pack',
      source: 'stripe',
      itemRef: 'pack:pearls-550',
      idempotencyKey: stripeKey,
      createdAt: new Date(h.clock.now()),
    });
    expect((await exportOf(who)).wallet.ledger.map((r) => r['idempotencyKey'])).toContain(
      stripeKey,
    );

    const res = await call(h, who, 'POST', '/api/me/delete', { password: PASSWORD });
    expect(res.statusCode).toBe(204);

    expect(
      await h.database.db.select().from(schema.wallet).where(eq(schema.wallet.userId, who.userId)),
    ).toEqual([]);
    expect(await ledgerOf(h, who)).toEqual([]);
    const kept = await h.database.db
      .select()
      .from(schema.ledger)
      .where(eq(schema.ledger.idempotencyKey, stripeKey));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ userId: null, delta: 550, source: 'stripe', reason: 'pack' });
    const game = await h.database.db
      .select()
      .from(schema.ledger)
      .where(eq(schema.ledger.source, 'game'));
    expect(game.every((r) => r.userId !== null)).toBe(true);
    expect((await ledgerOf(h, bystander.who)).length).toBeGreaterThan(0);
    expect(await balance(h, bystander.who)).toBeGreaterThan(0);
  });

  it('tells users about the wallet, the ledger and how long real-money rows are kept', () => {
    const text = JSON.stringify(PRIVACY_POLICY);
    expect(text).toContain('Pearls wallet and ledger');
    expect(text).toContain('10 years');
    expect(text).toContain('Luxembourg');
    expect(text).toContain('wallet and in-game Pearl ledger');
  });
});

describe('account deletion racing a purchase', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const waitForBlocked = async (count: number) => {
    for (let i = 0; i < 200; i++) {
      const { rows } = await h.database.pool.query<{ n: string }>(
        `select count(*) as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (Number(rows[0]?.n) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`fewer than ${count} requests are waiting on the user row lock`);
  };

  const expectGone = async (who: Account) => {
    expect(await ledgerOf(h, who)).toEqual([]);
    expect(
      await h.database.db.select().from(schema.wallet).where(eq(schema.wallet.userId, who.userId)),
    ).toEqual([]);
  };

  it('answers 401 and leaves no play row when the delete commits first', async () => {
    const who = await account(h);
    await walletOf(h, who);
    const holder = await h.database.pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from "user" where id = $1 for update', [who.userId]);
      const spent = purchase(h, who, 'background:bg-fw-misty-lake');
      await waitForBlocked(1);
      await holder.query('delete from ledger where user_id = $1 and source = $2', [
        who.userId,
        'game',
      ]);
      await holder.query('delete from "user" where id = $1', [who.userId]);
      await holder.query('commit');
      const res = await spent;
      expect(res.statusCode, res.body).toBe(401);
    } finally {
      holder.release();
    }
    await expectGone(who);
  });

  it('deletes everything after a purchase that finished before the delete started', async () => {
    const who = await account(h);
    await walletOf(h, who);
    const holder = await h.database.pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from "user" where id = $1 for key share', [who.userId]);
      const spent = purchase(h, who, 'background:bg-fw-misty-lake');
      expect((await spent).statusCode).toBe(200);
      const deleted = call(h, who, 'POST', '/api/me/delete', { password: PASSWORD });
      await waitForBlocked(1);
      await holder.query('commit');
      expect((await deleted).statusCode).toBe(204);
    } finally {
      holder.release();
    }
    await expectGone(who);
  });

  it('does not deadlock a tank-scoped purchase against the delete cascade', async () => {
    for (let round = 0; round < 3; round++) {
      const who = await account(h);
      await walletOf(h, who);
      const tank = await freeTank(h, who);
      const holder = await h.database.pool.connect();
      try {
        await holder.query('begin');
        await holder.query('select id from tanks where id = $1 for update', [tank.id]);
        const spent = buyFish(h, who, tank.id, 'neon-tetra', 'juvenile');
        await waitForBlocked(1);
        const deleted = call(h, who, 'POST', '/api/me/delete', { password: PASSWORD });
        await waitForBlocked(2);
        await holder.query('commit');
        const [spentRes, deletedRes] = await Promise.all([spent, deleted]);
        expect(deletedRes.statusCode, deletedRes.body).toBe(204);
        expect(spentRes.statusCode, spentRes.body).toBeLessThan(500);
      } finally {
        holder.release();
      }
      await expectGone(who);
    }
  });
});

describe('fry that sell for nothing', () => {
  let h: Harness;
  beforeAll(async () => {
    const base = loadEconomy();
    const discus = base.species['discus'];
    if (!discus) throw new Error('discus missing from economy.json');
    h = await createHarness({
      economy: {
        ...base,
        earn: { ...base.earn, frySale: { ...base.earn.frySale, percentOfJuvenilePrice: 1 } },
        species: { ...base.species, discus: { ...discus, juvenile: 50 } },
      },
    });
  });
  afterAll(() => h.close());

  it('refuses the sale with 409 and keeps the fry and the ledger untouched', async () => {
    const { who, tank } = await primed(h);
    const id = randomUUID();
    await h.database.db.insert(schema.fish).values({
      id,
      tankId: tank.id,
      species: 'discus',
      name: 'Fry',
      size: 0.01,
      sex: 'female',
      stage: 'fry',
      bornAt: new Date(h.clock.now()),
      personality: personalityFromFishId(id),
    });
    const before = (await ledgerOf(h, who)).length;
    const res = await call(h, who, 'POST', `/api/tanks/${tank.id}/fish/${id}/sell`);
    expect(res.statusCode).toBe(409);
    expect((await ledgerOf(h, who)).length).toBe(before);
    const [row] = await h.database.db.select().from(schema.fish).where(eq(schema.fish.id, id));
    expect(row?.status).toBe('alive');
  });
});

describe('migration grant', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const migration = readFileSync(new URL('../drizzle/0018_economy.sql', import.meta.url), 'utf8');
  const grants = migration
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => /^INSERT INTO "(wallet|ledger)"/.test(s));

  it('grants the amount in content/economy.json and nothing else', () => {
    expect(grants).toHaveLength(2);
    for (const statement of grants) {
      expect(statement).toContain(`${economy.grants.migration}`);
    }
  });

  it('gives each account that existed before the economy a wallet and one grant row', async () => {
    const early = await account(h);
    const alsoEarly = await account(h);
    await h.database.db.delete(schema.ledger);
    await h.database.db.delete(schema.wallet);
    for (const statement of grants) await h.database.db.execute(sql.raw(statement));
    for (const who of [early, alsoEarly]) {
      const rows = await ledgerOf(h, who);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        delta: economy.grants.migration,
        reason: 'grant',
        source: 'game',
        itemRef: 'grant:migration',
        idempotencyKey: 'grant-migration',
      });
      expect(await balance(h, who)).toBe(economy.grants.migration);
      expect(await ledgerOf(h, who)).toHaveLength(1);
    }
  });
});

describe('species lifecycle vs shop', () => {
  it('every species matures before it dies of old age', () => {
    for (const [id, spec] of loadCatalog()) {
      const adultAfter = spec.breeding?.fryGrowth?.adultAfterDays ?? 0;
      expect(adultAfter, id).toBeLessThan(spec.lifecycle.lifespanDays);
    }
  });

  it('prices every species the catalog can sell', () => {
    for (const id of loadCatalog().keys()) {
      expect(Object.hasOwn(economy.species, id), id).toBe(true);
    }
  });
});

export type { Tank };
