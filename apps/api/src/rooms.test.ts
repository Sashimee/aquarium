import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  apiErrorSchema,
  dataExportSchema,
  galleryResponseSchema,
  ownedRoomsResponseSchema,
  publicTankSchema,
  purchaseResponseSchema,
  roomRef,
  type RoomId,
  tankSchema,
  walletResponseSchema,
} from '@aquarium/shared';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from './db/index.ts';
import { loadEconomy } from './economy.ts';
import { APP_ORIGIN, createHarness, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
const economy = loadEconomy();
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

interface Account {
  cookie: string;
  userId: string;
}

async function account(h: Harness): Promise<Account> {
  const email = `t75-${Date.now()}-${counter++}@bas.lu`;
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
  who: Account | null,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) =>
  h.app.inject({
    method,
    url,
    headers: { ...jsonHeaders, ...(who ? { cookie: who.cookie } : {}) },
    ...(payload ? { payload } : {}),
  });

const buyRoom = (h: Harness, who: Account, roomId: RoomId, idempotencyKey = randomUUID()) =>
  call(h, who, 'POST', '/api/shop/purchase', {
    idempotencyKey,
    itemRef: roomRef(roomId),
  });

const errorOf = (res: LightMyRequestResponse) => apiErrorSchema.parse(res.json()).error;

async function balance(h: Harness, who: Account) {
  const res = await call(h, who, 'GET', '/api/wallet');
  expect(res.statusCode).toBe(200);
  return walletResponseSchema.parse(res.json()).wallet.balance;
}

async function topUp(h: Harness, who: Account, pearls: number) {
  await balance(h, who);
  await h.database.db.insert(schema.ledger).values({
    userId: who.userId,
    delta: pearls,
    reason: 'grant',
    source: 'game',
    itemRef: 'grant:test-topup',
    idempotencyKey: `topup-${randomUUID()}`,
    createdAt: new Date(h.clock.now()),
  });
  const current = await balance(h, who);
  await h.database.db
    .update(schema.wallet)
    .set({ balance: current + pearls })
    .where(eq(schema.wallet.userId, who.userId));
}

async function newTank(h: Harness, who: Account) {
  const res = await call(h, who, 'POST', '/api/tanks', {
    name: 'Home',
    biome: 'freshwater',
    idempotencyKey: randomUUID(),
  });
  expect(res.statusCode).toBe(201);
  return tankSchema.parse(res.json());
}

describe('rooms on the server (T75)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const ownedOf = async (who: Account) => {
    const res = await call(h, who, 'GET', '/api/rooms');
    expect(res.statusCode).toBe(200);
    return ownedRoomsResponseSchema.parse(res.json()).owned;
  };

  it('buys a room at its content/economy.json price and unlocks it for every tank', async () => {
    const who = await account(h);
    await topUp(h, who, 2000);
    const first = await newTank(h, who);
    const second = await newTank(h, who);
    const before = await balance(h, who);

    const res = await buyRoom(h, who, 'room-library');
    expect(res.statusCode).toBe(200);
    const bought = purchaseResponseSchema.parse(res.json());
    expect(bought.entry.delta).toBe(-economy.rooms['room-library']);
    expect(bought.entry.itemRef).toBe(roomRef('room-library'));
    expect(bought.wallet.balance).toBe(before - economy.rooms['room-library']);
    expect(await ownedOf(who)).toEqual(['room-library']);

    for (const tank of [first, second]) {
      const set = await call(h, who, 'PATCH', `/api/tanks/${tank.id}`, { roomId: 'room-library' });
      expect(set.statusCode).toBe(200);
      expect(tankSchema.parse(set.json()).roomId).toBe('room-library');
    }
  });

  it('refuses a room already owned with 409 room_already_owned and charges nothing', async () => {
    const who = await account(h);
    await topUp(h, who, 2000);
    expect((await buyRoom(h, who, 'room-zen')).statusCode).toBe(200);
    const after = await balance(h, who);

    const again = await buyRoom(h, who, 'room-zen');
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).reason).toBe('room_already_owned');
    expect(await balance(h, who)).toBe(after);
    expect(await ownedOf(who)).toEqual(['room-zen']);
  });

  it('refuses an overdraft and leaves no room, no debit and no ledger row', async () => {
    const who = await account(h);
    await balance(h, who);
    await h.database.db
      .update(schema.wallet)
      .set({ balance: economy.rooms['room-submarine'] - 1 })
      .where(eq(schema.wallet.userId, who.userId));
    const ledgerBefore = (
      await h.database.db.select().from(schema.ledger).where(eq(schema.ledger.userId, who.userId))
    ).length;

    const res = await buyRoom(h, who, 'room-submarine');
    expect(res.statusCode).toBe(402);
    expect(errorOf(res).code).toBe('insufficient_pearls');
    expect(await balance(h, who)).toBe(economy.rooms['room-submarine'] - 1);
    expect(await ownedOf(who)).toEqual([]);
    expect(
      (await h.database.db.select().from(schema.ledger).where(eq(schema.ledger.userId, who.userId)))
        .length,
    ).toBe(ledgerBefore);
  });

  it('charges once when the same idempotency key is sent again, even in parallel', async () => {
    const who = await account(h);
    await topUp(h, who, 3000);
    const before = await balance(h, who);
    const k = randomUUID();

    const [a, b] = await Promise.all([
      buyRoom(h, who, 'room-beach', k),
      buyRoom(h, who, 'room-beach', k),
    ]);
    const later = await buyRoom(h, who, 'room-beach', k);
    for (const res of [a, b, later]) {
      expect(res.statusCode).toBe(200);
    }
    expect(
      [a, b, later].filter((r) => purchaseResponseSchema.parse(r.json()).replayed),
    ).toHaveLength(2);
    expect(await balance(h, who)).toBe(before - economy.rooms['room-beach']);
    expect(await ownedOf(who)).toEqual(['room-beach']);
  });

  it('lets two parallel purchases of one room with different keys charge only once', async () => {
    const who = await account(h);
    await topUp(h, who, 3000);
    const before = await balance(h, who);
    const results = await Promise.all([buyRoom(h, who, 'room-loft'), buyRoom(h, who, 'room-loft')]);
    expect(results.map((r) => r.statusCode).toSorted()).toEqual([200, 409]);
    expect(await balance(h, who)).toBe(before - economy.rooms['room-loft']);
  });

  it('refuses an unknown room, a free room and a key reused for another room', async () => {
    const who = await account(h);
    await topUp(h, who, 3000);
    const unknown = await call(h, who, 'POST', '/api/shop/purchase', {
      idempotencyKey: randomUUID(),
      itemRef: 'room:room-igloo',
    });
    expect(unknown.statusCode).toBe(400);
    expect(errorOf(unknown).code).toBe('validation_failed');
    expect((await buyRoom(h, who, 'room-living')).statusCode).toBe(400);
    expect((await buyRoom(h, who, 'room-bedroom')).statusCode).toBe(400);

    const k = randomUUID();
    expect((await buyRoom(h, who, 'room-cabin', k)).statusCode).toBe(200);
    const reused = await buyRoom(h, who, 'room-sushi', k);
    expect(reused.statusCode).toBe(409);
    expect(await ownedOf(who)).toEqual(['room-cabin']);
  });

  it('needs a signed-in user', async () => {
    expect((await call(h, null, 'GET', '/api/rooms')).statusCode).toBe(401);
    expect(
      (
        await call(h, null, 'POST', '/api/shop/purchase', {
          idempotencyKey: randomUUID(),
          itemRef: roomRef('room-zen'),
        })
      ).statusCode,
    ).toBe(401);
  });

  describe('setting a tank room', () => {
    it('takes the free rooms and null without owning anything, and refuses an unowned one', async () => {
      const who = await account(h);
      const tank = await newTank(h, who);
      expect(tank.roomId).toBe('room-living');

      for (const roomId of ['room-bedroom', 'room-living', null]) {
        const res = await call(h, who, 'PATCH', `/api/tanks/${tank.id}`, { roomId });
        expect(res.statusCode).toBe(200);
        expect(tankSchema.parse(res.json()).roomId).toBe(roomId);
      }

      const refused = await call(h, who, 'PATCH', `/api/tanks/${tank.id}`, {
        roomId: 'room-office',
      });
      expect(refused.statusCode).toBe(409);
      expect(errorOf(refused).reason).toBe('room_not_owned');
    });

    it('does not let one account use a room another account bought', async () => {
      const buyer = await account(h);
      const other = await account(h);
      await topUp(h, buyer, 1000);
      expect((await buyRoom(h, buyer, 'room-sushi')).statusCode).toBe(200);
      const tank = await newTank(h, other);
      const res = await call(h, other, 'PATCH', `/api/tanks/${tank.id}`, { roomId: 'room-sushi' });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).reason).toBe('room_not_owned');
    });
  });

  describe('the home-office grant migration', () => {
    it('gave accounts that existed before it the office through a 0-Pearl grant, once', async () => {
      const statements = readFileSync(
        new URL('../drizzle/0037_room_office_grant.sql', import.meta.url),
        'utf8',
      ).split('--> statement-breakpoint');
      const legacy = await account(h);
      const bystander = await account(h);
      await h.database.db
        .insert(schema.ownedRooms)
        .values({ userId: legacy.userId, roomId: 'room-office' });
      expect(await ownedOf(legacy)).toEqual(['room-office']);
      await h.database.db
        .delete(schema.ownedRooms)
        .where(eq(schema.ownedRooms.userId, legacy.userId));
      expect(await ownedOf(legacy)).toEqual([]);
      for (let run = 0; run < 2; run += 1) {
        for (const statement of statements) await h.database.pool.query(statement);
      }

      for (const who of [legacy, bystander]) {
        const grants = await h.database.db
          .select()
          .from(schema.ledger)
          .where(eq(schema.ledger.userId, who.userId));
        const office = grants.filter((r) => r.itemRef === roomRef('room-office'));
        expect(office).toHaveLength(1);
        expect(office[0]).toMatchObject({ delta: 0, reason: 'grant', source: 'game' });
        expect(await ownedOf(who)).toContain('room-office');
      }

      const tank = await newTank(h, legacy);
      const res = await call(h, legacy, 'PATCH', `/api/tanks/${tank.id}`, {
        roomId: 'room-office',
      });
      expect(res.statusCode).toBe(200);
      const wallet = await call(h, legacy, 'GET', '/api/wallet');
      expect(walletResponseSchema.parse(wallet.json()).wallet.balance).toBe(
        economy.grants.starting,
      );
      expect((await buyRoom(h, legacy, 'room-office')).statusCode).toBe(409);
    });
  });

  describe('buying a room', () => {
    it('refuses a tankId, since rooms belong to the account', async () => {
      const who = await account(h);
      await topUp(h, who, 1000);
      const tank = await newTank(h, who);
      const res = await call(h, who, 'POST', '/api/shop/purchase', {
        idempotencyKey: randomUUID(),
        itemRef: roomRef('room-zen'),
        tankId: tank.id,
      });
      expect(res.statusCode).toBe(400);
      expect(await ownedOf(who)).toEqual([]);
      expect(await balance(h, who)).toBe(1000 + economy.grants.starting);
    });
  });

  describe('read-only places', () => {
    it('shows the owner room in a public link and the gallery, and offers no way to change it', async () => {
      const owner = await account(h);
      await topUp(h, owner, 1000);
      expect((await buyRoom(h, owner, 'room-zen')).statusCode).toBe(200);
      const tank = await newTank(h, owner);
      await call(h, owner, 'PATCH', `/api/tanks/${tank.id}`, { roomId: 'room-zen' });
      const shared = tankSchema.parse(
        (await call(h, owner, 'POST', `/api/tanks/${tank.id}/share`)).json(),
      );
      if (!shared.shareToken) throw new Error('no share token');

      const visitor = await account(h);
      const view = await call(h, visitor, 'GET', `/api/public/${shared.shareToken}`);
      expect(view.statusCode).toBe(200);
      expect(publicTankSchema.parse(view.json()).roomId).toBe('room-zen');
      expect(await ownedOf(visitor)).toEqual([]);

      const patch = await call(h, visitor, 'PATCH', `/api/public/${shared.shareToken}`, {
        roomId: 'room-living',
      });
      expect(patch.statusCode).toBe(404);
      const foreign = await call(h, visitor, 'PATCH', `/api/tanks/${tank.id}`, {
        roomId: 'room-living',
      });
      expect(foreign.statusCode).toBe(404);

      await call(h, owner, 'PUT', `/api/tanks/${tank.id}/gallery`, { listed: true });
      const gallery = galleryResponseSchema.parse(
        (await call(h, visitor, 'GET', '/api/gallery')).json(),
      );
      expect(gallery.entries.find((e) => e.id === tank.id)?.roomId).toBe('room-zen');
    });
  });

  describe('account export and deletion', () => {
    it('exports the owned rooms and each tank room choice, then deletes them with the account', async () => {
      const who = await account(h);
      await topUp(h, who, 2000);
      expect((await buyRoom(h, who, 'room-cabin')).statusCode).toBe(200);
      const tank = await newTank(h, who);
      await call(h, who, 'PATCH', `/api/tanks/${tank.id}`, { roomId: 'room-cabin' });

      const res = await call(h, who, 'POST', '/api/me/export');
      expect(res.statusCode).toBe(200);
      const data = dataExportSchema.parse(res.json());
      expect(data.ownedRooms.map((r) => r.roomId)).toEqual(['room-cabin']);
      const exported = data.tanks.find((t) => t.tank['id'] === tank.id);
      expect(exported?.tank['roomId']).toBe('room-cabin');
      expect(exported?.tank['roomSetAt']).not.toBeNull();

      const gone = await call(h, who, 'POST', '/api/me/delete', { password: PASSWORD });
      expect(gone.statusCode).toBe(204);
      expect(
        await h.database.db
          .select()
          .from(schema.ownedRooms)
          .where(eq(schema.ownedRooms.userId, who.userId)),
      ).toEqual([]);
      expect(
        await h.database.db.select().from(schema.tanks).where(eq(schema.tanks.id, tank.id)),
      ).toEqual([]);
    });

    it("does not export another account's rooms", async () => {
      const a = await account(h);
      const b = await account(h);
      await topUp(h, a, 1000);
      expect((await buyRoom(h, a, 'room-shop')).statusCode).toBe(200);
      const data = dataExportSchema.parse((await call(h, b, 'POST', '/api/me/export')).json());
      expect(data.ownedRooms.map((r) => r.roomId)).not.toContain('room-shop');
    });
  });
});
