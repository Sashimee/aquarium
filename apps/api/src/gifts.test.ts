import { randomUUID } from 'node:crypto';
import {
  acceptGiftResponseSchema,
  apiErrorSchema,
  cancelGiftResponseSchema,
  confirmGiftResponseSchema,
  createGiftResponseSchema,
  dataExportSchema,
  declineGiftResponseSchema,
  GIFT_MAX_OPEN_RECEIVED,
  GIFT_MAX_OPEN_SENT,
  giftListResponseSchema,
  tankSchema,
  type Tank,
} from '@aquarium/shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from './db/index.ts';
import { DEFAULT_CARE_LIMITS } from './tanks.ts';
import { APP_ORIGIN, createHarness, topUp, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
const HOUR_MS = 3_600_000;
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

interface Account {
  cookie: string;
  userId: string;
  handle: string;
  email: string;
}

async function account(h: Harness, opts: { verify?: boolean } = {}): Promise<Account> {
  const n = counter++;
  const email = `t63-${Date.now()}-${n}@bas.lu`;
  const signedUp = await h.app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: jsonHeaders,
    payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/verify-email' },
  });
  let cookie = cookieOf(signedUp);
  if (opts.verify !== false) {
    const mail = h.outbox.findLast((m) => m.to === email);
    const link = /https?:\/\/\S+verify-email\?\S+/.exec(mail?.text ?? '')?.[0];
    if (!link) throw new Error('no verification link');
    const url = new URL(link);
    cookie = cookieOf(
      await h.app.inject({
        method: 'GET',
        url: url.pathname + url.search,
        headers: { cookie: cookieOf(signedUp) },
      }),
    );
    if (!cookie) throw new Error('verification did not sign in');
  }
  const handle = `gifter_${Date.now().toString(36)}_${n}`.slice(0, 20);
  const [user] = await h.database.db
    .update(schema.user)
    .set({ handle })
    .where(eq(schema.user.email, email))
    .returning();
  if (!user) throw new Error('user missing');
  return { cookie, userId: user.id, handle, email };
}

const call = (
  h: Harness,
  who: Account | null,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: object,
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method,
    url,
    headers: { ...jsonHeaders, ...(who ? { cookie: who.cookie } : {}) },
    ...(payload ? { payload } : {}),
  });

const errorOf = (res: LightMyRequestResponse) => apiErrorSchema.parse(res.json()).error;

async function makeTank(
  h: Harness,
  who: Account,
  body: { biome?: 'freshwater' | 'reef'; quarantine?: boolean; gifts?: boolean } = {},
): Promise<string> {
  await topUp(h);
  const res = await call(h, who, 'POST', '/api/tanks', {
    name: 'Tank',
    idempotencyKey: randomUUID(),
    biome: body.biome ?? 'freshwater',
    ...(body.quarantine ? { quarantine: true, size: 'nano30' } : {}),
  });
  expect(res.statusCode).toBe(201);
  const id = tankSchema.parse(res.json()).id;
  if (body.gifts !== false) {
    await h.database.db
      .update(schema.tanks)
      .set({ acceptsGifts: true })
      .where(eq(schema.tanks.id, id));
  }
  return id;
}

async function addFish(
  h: Harness,
  tankId: string,
  opts: {
    status?: 'alive' | 'dead';
    name?: string;
    disease?: { kind: 'ich'; since: string; severity: number; treatedUntil: string | null };
  } = {},
): Promise<string> {
  const dead = opts.status === 'dead';
  const [row] = await h.database.db
    .insert(schema.fish)
    .values({
      tankId,
      species: 'neon-tetra',
      name: opts.name ?? 'Pip',
      sex: 'female',
      size: 0.03,
      personality: { boldness: 0.6, greed: 0.4, sociability: 0.5 },
      health: 0.8,
      status: opts.status ?? 'alive',
      diedAt: dead ? new Date(h.clock.now()) : null,
      cause: dead ? 'old_age' : null,
      introducedAt: new Date(h.clock.now() - 30 * 24 * HOUR_MS),
      disease: opts.disease ?? null,
    })
    .returning();
  if (!row) throw new Error('fish insert failed');
  return row.id;
}

async function ensureOpenTank(h: Harness, who: Account): Promise<void> {
  const open = await h.database.db
    .select({ id: schema.tanks.id })
    .from(schema.tanks)
    .where(and(eq(schema.tanks.ownerId, who.userId), eq(schema.tanks.acceptsGifts, true)))
    .limit(1);
  if (open.length === 0) await makeTank(h, who);
}

const offer = async (
  h: Harness,
  who: Account,
  body: {
    fromTankId: string;
    fishId: string;
    to: Account;
    wantsReturn?: boolean;
    key?: string;
    raw?: boolean;
  },
) => {
  if (!body.raw) await ensureOpenTank(h, body.to);
  return call(h, who, 'POST', '/api/gifts', {
    fromTankId: body.fromTankId,
    fishId: body.fishId,
    toHandle: body.to.handle,
    ...(body.wantsReturn ? { wantsReturn: true } : {}),
    idempotencyKey: body.key ?? randomUUID(),
  });
};

const offerId = (res: LightMyRequestResponse): string => {
  expect(res.statusCode, res.body).toBe(201);
  return createGiftResponseSchema.parse(res.json()).offer.id;
};

const accept = (
  h: Harness,
  who: Account,
  id: string,
  body: { toTankId: string; returnFishId?: string; key?: string },
) =>
  call(h, who, 'POST', `/api/gifts/${id}/accept`, {
    toTankId: body.toTankId,
    ...(body.returnFishId ? { returnFishId: body.returnFishId } : {}),
    idempotencyKey: body.key ?? randomUUID(),
  });

const confirm = (h: Harness, who: Account, id: string, toTankId: string, key = randomUUID()) =>
  call(h, who, 'POST', `/api/gifts/${id}/confirm`, { toTankId, idempotencyKey: key });

const getTank = async (h: Harness, who: Account, tankId: string): Promise<Tank> => {
  const res = await call(h, who, 'GET', `/api/tanks/${tankId}`);
  expect(res.statusCode).toBe(200);
  return tankSchema.parse(res.json());
};

const fishRows = (h: Harness, id: string) =>
  h.database.db.select().from(schema.fish).where(eq(schema.fish.id, id));

const list = async (h: Harness, who: Account) => {
  const res = await call(h, who, 'GET', '/api/gifts');
  expect(res.statusCode, res.body).toBe(200);
  return giftListResponseSchema.parse(res.json());
};

const offerRow = async (h: Harness, id: string) => {
  const [row] = await h.database.db
    .select()
    .from(schema.giftOffers)
    .where(eq(schema.giftOffers.id, id));
  if (!row) throw new Error('offer missing');
  return row;
};

async function holdingLock(
  h: Harness,
  lock: SQL,
  then: (
    tx: Parameters<Parameters<Harness['database']['db']['transaction']>[0]>[0],
  ) => Promise<void>,
) {
  const held = latch<unknown>();
  const gate = latch();
  const done = h.database.db.transaction(async (tx) => {
    await tx.execute(lock);
    const pid = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]?.['pid'];
    held.open(pid);
    await gate.opened;
    await then(tx);
  });
  const pid = await Promise.race([
    held.opened,
    done.then(() => {
      throw new Error('the lock transaction ended before the lock was held');
    }),
  ]);
  return {
    async whenBlocked() {
      let waited = false;
      let waitError: unknown;
      try {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const blocked = await h.database.db.execute(
            sql`select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`,
          );
          if (blocked.rows.length > 0) break;
          if (Date.now() > deadline) throw new Error('the request never blocked on the held lock');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        waited = true;
      } catch (error) {
        waitError = error;
      }
      gate.open();
      if (waited) {
        await done;
        return;
      }
      await done.catch(() => undefined);
      throw waitError;
    },
    async release() {
      gate.open();
      await done.catch(() => undefined);
    },
  };
}

function latch<T = void>() {
  let open: (value: T) => void = () => undefined;
  const opened = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe('gifting and trading fish', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  describe('making an offer', () => {
    it('takes the fish out of the tank into escrow and shows it to both players by handle only', async () => {
      const a = await account(h);
      const b = await account(h);
      const tank = await makeTank(h, a);
      const fishId = await addFish(h, tank, { name: 'Goldie' });

      const res = await offer(h, a, { fromTankId: tank, fishId, to: b });
      const created = createGiftResponseSchema.parse(res.json());
      expect(res.statusCode).toBe(201);
      expect(created.tank.fish.map((f) => f.id)).not.toContain(fishId);
      expect(created.offer).toMatchObject({
        status: 'open',
        role: 'sender',
        counterpart: b.handle,
        wantsReturn: false,
        pledged: null,
      });
      expect((await getTank(h, a, tank)).fish.map((f) => f.id)).not.toContain(fishId);
      expect(await fishRows(h, fishId)).toHaveLength(0);

      const seenByB = (await list(h, b)).incoming;
      expect(seenByB).toHaveLength(1);
      expect(seenByB[0]).toMatchObject({ role: 'recipient', counterpart: a.handle });
      for (const body of [res.body, JSON.stringify(seenByB)]) {
        expect(body).not.toContain(a.email);
        expect(body).not.toContain(b.email);
        expect(body).not.toContain(a.userId);
        expect(body).not.toContain(b.userId);
      }
    });

    it('refuses a gift to yourself, an unknown handle, a dead fish and a fish from another tank', async () => {
      const a = await account(h);
      const b = await account(h);
      const tank = await makeTank(h, a);
      const other = await makeTank(h, a);
      const fishId = await addFish(h, tank);
      const dead = await addFish(h, tank, { status: 'dead' });
      const elsewhere = await addFish(h, other);

      expect((await offer(h, a, { fromTankId: tank, fishId, to: a })).statusCode).toBe(400);
      const ghost = await call(h, a, 'POST', '/api/gifts', {
        fromTankId: tank,
        fishId,
        toHandle: 'nobody_here_1',
        idempotencyKey: randomUUID(),
      });
      expect(ghost.statusCode).toBe(404);
      const deadRes = await offer(h, a, { fromTankId: tank, fishId: dead, to: b });
      expect(deadRes.statusCode).toBe(409);
      expect(errorOf(deadRes).reason).toBe('fish_dead');
      expect((await offer(h, a, { fromTankId: tank, fishId: elsewhere, to: b })).statusCode).toBe(
        404,
      );
      expect(await fishRows(h, fishId)).toHaveLength(1);
      expect(await fishRows(h, elsewhere)).toHaveLength(1);
    });

    it("404s on another player's tank and requires a signed-in caller", async () => {
      const a = await account(h);
      const b = await account(h);
      const tank = await makeTank(h, a);
      const fishId = await addFish(h, tank);
      expect((await offer(h, b, { fromTankId: tank, fishId, to: a })).statusCode).toBe(404);
      const anon = await call(h, null, 'POST', '/api/gifts', {
        fromTankId: tank,
        fishId,
        toHandle: b.handle,
        idempotencyKey: randomUUID(),
      });
      expect(anon.statusCode).toBe(401);
      expect((await call(h, null, 'GET', '/api/gifts')).statusCode).toBe(401);
      expect(await fishRows(h, fishId)).toHaveLength(1);
    });

    it('caps open offers per sender and per recipient', async () => {
      const a = await account(h);
      const b = await account(h);
      const tank = await makeTank(h, a);
      for (let i = 0; i < GIFT_MAX_OPEN_SENT; i++) {
        offerId(await offer(h, a, { fromTankId: tank, fishId: await addFish(h, tank), to: b }));
      }
      const extra = await addFish(h, tank);
      const capped = await offer(h, a, { fromTankId: tank, fishId: extra, to: b });
      expect(capped.statusCode).toBe(409);
      expect(errorOf(capped).reason).toBe('too_many_offers');
      expect(await fishRows(h, extra)).toHaveLength(1);

      const target = await account(h);
      const senders = await Promise.all(
        Array.from({ length: GIFT_MAX_OPEN_RECEIVED / GIFT_MAX_OPEN_SENT + 1 }, () => account(h)),
      );
      const results: LightMyRequestResponse[] = [];
      for (const s of senders) {
        const t = await makeTank(h, s);
        for (let i = 0; i < GIFT_MAX_OPEN_SENT; i++) {
          results.push(
            await offer(h, s, { fromTankId: t, fishId: await addFish(h, t), to: target }),
          );
        }
      }
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(GIFT_MAX_OPEN_RECEIVED);
      const refused = results.filter((r) => r.statusCode === 409);
      expect(refused.length).toBeGreaterThan(0);
      expect(refused.map((r) => errorOf(r).reason)).toEqual(refused.map(() => 'too_many_offers'));
    });

    it('replays a known idempotency key before the rate limit and refuses it for another offer', async () => {
      const limited = await createHarness({
        careLimits: { ...DEFAULT_CARE_LIMITS, gift: { max: 1, windowMs: 60_000 } },
      });
      try {
        const a = await account(limited);
        const b = await account(limited);
        const tank = await makeTank(limited, a);
        const first = await addFish(limited, tank);
        const second = await addFish(limited, tank);
        const key = randomUUID();
        const made = await offer(limited, a, { fromTankId: tank, fishId: first, to: b, key });
        const id = offerId(made);

        const again = await offer(limited, a, { fromTankId: tank, fishId: first, to: b, key });
        expect(again.statusCode).toBe(200);
        expect(createGiftResponseSchema.parse(again.json()).offer.id).toBe(id);

        const reused = await offer(limited, a, { fromTankId: tank, fishId: second, to: b, key });
        expect(reused.statusCode).toBe(409);
        expect(errorOf(reused).reason).toBe('key_reused');

        const fresh = await offer(limited, a, { fromTankId: tank, fishId: second, to: b });
        expect(fresh.statusCode).toBe(429);
        expect(await fishRows(limited, second)).toHaveLength(1);
        expect((await list(limited, a)).outgoing).toHaveLength(1);
      } finally {
        await limited.close();
      }
    });
  });

  describe('accepting a gift', () => {
    it('delivers the same fish into the recipient tank as a new arrival', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const tankB = await makeTank(h, b);
      const fishId = await addFish(h, tankA, { name: 'Goldie' });
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));

      const before = h.clock.now();
      const res = await accept(h, b, id, { toTankId: tankB });
      expect(res.statusCode, res.body).toBe(200);
      const done = acceptGiftResponseSchema.parse(res.json());
      expect(done.offer.status).toBe('accepted');
      expect(done.arrival).toMatchObject({ fishId, tankId: tankB });
      expect(done.arrival?.stress).toBeGreaterThanOrEqual(0);
      expect(done.tank.fish.map((f) => f.id)).toContain(fishId);

      const [row] = await fishRows(h, fishId);
      expect(row).toMatchObject({ tankId: tankB, name: 'Goldie', status: 'alive' });
      expect(row?.introducedAt?.getTime()).toBeGreaterThanOrEqual(before);
      expect(row?.previousTankId).toBeNull();
      expect((await getTank(h, a, tankA)).fish).toHaveLength(0);
      expect((await list(h, a)).outgoing[0]?.status).toBe('accepted');
    });

    it('reports the stress the destination water puts on the arriving species', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const tankB = await makeTank(h, b);
      await h.database.db
        .update(schema.tanks)
        .set({
          chemistry: {
            nitrite: 0,
            ph: 9.2,
            kh: 4,
            temperatureC: 25,
            salinity: 0,
            bacteria: { ammoniaOxidisers: 1, nitriteOxidisers: 1 },
          },
        })
        .where(eq(schema.tanks.id, tankB));
      const fishId = await addFish(h, tankA);
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));
      const done = acceptGiftResponseSchema.parse(
        (await accept(h, b, id, { toTankId: tankB })).json(),
      );
      expect(done.arrival?.stress).toBeGreaterThan(0);
    });

    it('replays the same key and refuses another key once settled, with exactly one fish', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const tankB = await makeTank(h, b);
      const fishId = await addFish(h, tankA);
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));
      const key = randomUUID();

      expect((await accept(h, b, id, { toTankId: tankB, key })).statusCode).toBe(200);
      const replay = await accept(h, b, id, { toTankId: tankB, key });
      expect(replay.statusCode).toBe(200);
      expect(acceptGiftResponseSchema.parse(replay.json()).arrival?.fishId).toBe(fishId);
      const other = await accept(h, b, id, { toTankId: tankB });
      expect(other.statusCode).toBe(409);
      expect(errorOf(other).reason).toBe('offer_closed');
      expect(await fishRows(h, fishId)).toHaveLength(1);
    });

    it('never duplicates the fish when two accepts race', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const tank1 = await makeTank(h, b);
      const tank2 = await makeTank(h, b);
      for (let round = 0; round < 6; round++) {
        const fishId = await addFish(h, tankA);
        const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));
        const results = await Promise.all([
          accept(h, b, id, { toTankId: tank1 }),
          accept(h, b, id, { toTankId: tank2 }),
        ]);
        expect(results.map((r) => r.statusCode).toSorted()).toEqual([200, 409]);
        const losers = results.filter((r) => r.statusCode === 409);
        expect(losers.map((r) => errorOf(r).reason)).toEqual(['offer_closed']);
        const rows = await fishRows(h, fishId);
        expect(rows).toHaveLength(1);
        expect([tank1, tank2]).toContain(rows[0]?.tankId);
      }
    });

    it('never duplicates the fish when an accept races a cancel', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const tankB = await makeTank(h, b);
      const fishId = await addFish(h, tankA);
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));

      const [acc, can] = await Promise.all([
        accept(h, b, id, { toTankId: tankB }),
        call(h, a, 'POST', `/api/gifts/${id}/cancel`),
      ]);
      expect([acc.statusCode, can.statusCode].toSorted()).toEqual([200, 409]);
      const rows = await fishRows(h, fishId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tankId).toBe(acc.statusCode === 200 ? tankB : tankA);
    });

    it('refuses a wrong-biome and a full destination tank and keeps the offer open', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const reef = await makeTank(h, b, { biome: 'reef' });
      const small = await makeTank(h, b, { quarantine: true });
      for (let i = 0; i < 12; i++) await addFish(h, small);
      const fishId = await addFish(h, tankA);
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));

      const biome = await accept(h, b, id, { toTankId: reef });
      expect(biome.statusCode).toBe(409);
      expect(errorOf(biome).reason).toBe('wrong_biome');
      const full = await accept(h, b, id, { toTankId: small });
      expect(full.statusCode).toBe(409);
      expect(errorOf(full).reason).toBe('tank_full');
      expect((await offerRow(h, id)).status).toBe('open');
      expect(await fishRows(h, fishId)).toHaveLength(0);
    });

    it("404s on a destination tank that is not the recipient's", async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const fishId = await addFish(h, tankA);
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));
      expect((await accept(h, b, id, { toTankId: tankA })).statusCode).toBe(404);
      expect((await accept(h, b, id, { toTankId: randomUUID() })).statusCode).toBe(404);
      expect((await offerRow(h, id)).status).toBe('open');
    });

    it('rejects a fish named in return for a plain gift', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const tankB = await makeTank(h, b);
      const fishId = await addFish(h, tankA);
      const mine = await addFish(h, tankB);
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));
      const res = await accept(h, b, id, { toTankId: tankB, returnFishId: mine });
      expect(res.statusCode).toBe(400);
      expect((await offerRow(h, id)).status).toBe('open');
    });
  });

  describe('declining, cancelling and expiring', () => {
    it('returns the fish to the sender tank unchanged when the recipient declines', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const fishId = await addFish(h, tankA, { name: 'Goldie' });
      const [original] = await fishRows(h, fishId);
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));

      const res = await call(h, b, 'POST', `/api/gifts/${id}/decline`);
      expect(res.statusCode, res.body).toBe(200);
      expect(declineGiftResponseSchema.parse(res.json()).offer.status).toBe('declined');
      const [back] = await fishRows(h, fishId);
      expect(back).toMatchObject({ tankId: tankA, name: 'Goldie', status: 'alive' });
      expect(back?.introducedAt).toEqual(original?.introducedAt);
      expect(back?.bornAt).toEqual(original?.bornAt);

      const again = await call(h, b, 'POST', `/api/gifts/${id}/decline`);
      expect(again.statusCode).toBe(200);
      expect(await fishRows(h, fishId)).toHaveLength(1);
      const cancel = await call(h, a, 'POST', `/api/gifts/${id}/cancel`);
      expect(cancel.statusCode).toBe(409);
      expect(errorOf(cancel).reason).toBe('offer_closed');
    });

    it('returns the fish and the sender tank when the sender cancels', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const tankB = await makeTank(h, b);
      const fishId = await addFish(h, tankA);
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));

      const res = await call(h, a, 'POST', `/api/gifts/${id}/cancel`);
      expect(res.statusCode, res.body).toBe(200);
      const done = cancelGiftResponseSchema.parse(res.json());
      expect(done.offer.status).toBe('cancelled');
      expect(done.tank.fish.map((f) => f.id)).toContain(fishId);
      expect((await call(h, a, 'POST', `/api/gifts/${id}/cancel`)).statusCode).toBe(200);

      const late = await accept(h, b, id, { toTankId: tankB });
      expect(late.statusCode).toBe(409);
      expect(errorOf(late).reason).toBe('offer_closed');
      expect(await fishRows(h, fishId)).toHaveLength(1);
    });

    it('expires an offer: a late accept is refused and the fish is back with its sender', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const tankB = await makeTank(h, b);
      const fishId = await addFish(h, tankA);
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));

      h.clock.advance(73 * HOUR_MS);
      const late = await accept(h, b, id, { toTankId: tankB });
      expect(late.statusCode).toBe(409);
      expect(errorOf(late).reason).toBe('offer_expired');
      const [row] = await fishRows(h, fishId);
      expect(row?.tankId).toBe(tankA);
      expect((await offerRow(h, id)).status).toBe('expired');
    });

    it('settles expired offers when either side lists them, and in the sweeper', async () => {
      const a = await account(h);
      const b = await account(h);
      const c = await account(h);
      const tankA = await makeTank(h, a);
      const tankC = await makeTank(h, c);
      const f1 = await addFish(h, tankA);
      const f2 = await addFish(h, tankC);
      const id1 = offerId(await offer(h, a, { fromTankId: tankA, fishId: f1, to: b }));
      const id2 = offerId(await offer(h, c, { fromTankId: tankC, fishId: f2, to: b }));

      h.clock.advance(73 * HOUR_MS);
      const seen = await list(h, b);
      expect(seen.incoming.find((o) => o.id === id1)?.status).toBe('expired');
      expect(await fishRows(h, f1)).toHaveLength(1);
      expect((await offerRow(h, id2)).status).toBe('expired');
      expect(await fishRows(h, f2)).toHaveLength(1);
      await h.app.settleDueGifts();
      expect(await h.app.settleDueGifts()).toBe(0);
    });

    it('settles an offer as declined and returns the fish when the recipient deletes their account', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const fishId = await addFish(h, tankA);
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));

      const gone = await call(h, b, 'POST', '/api/me/delete', { password: PASSWORD });
      expect(gone.statusCode, gone.body).toBeLessThan(300);
      expect((await offerRow(h, id)).toUserId).toBeNull();
      expect((await fishRows(h, fishId))[0]?.tankId).toBe(tankA);
      expect((await offerRow(h, id)).status).toBe('declined');
    });

    it('settles the deleted recipient offers even when due offers elsewhere fill the sweep batch', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      await makeTank(h, b);
      const past = new Date(h.clock.now() - HOUR_MS);
      const flooderId = randomUUID();
      await h.database.db.insert(schema.user).values({
        id: flooderId,
        name: 'Flooder',
        email: `flooder-${flooderId}@bas.lu`,
        emailVerified: true,
      });
      await h.database.db.insert(schema.giftOffers).values(
        Array.from({ length: 105 }, () => ({
          fromUserId: flooderId,
          toUserId: flooderId,
          fromTankId: tankA,
          fish: {},
          creationKey: randomUUID(),
          expiresAt: past,
        })),
      );
      try {
        const fishId = await addFish(h, tankA);
        const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));
        const gone = await call(h, b, 'POST', '/api/me/delete', { password: PASSWORD });
        expect(gone.statusCode, gone.body).toBe(204);
        expect((await offerRow(h, id)).status).toBe('declined');
        expect((await fishRows(h, fishId))[0]?.tankId).toBe(tankA);
      } finally {
        await h.database.db.delete(schema.user).where(eq(schema.user.id, flooderId));
      }
    });
  });

  describe('escrow', () => {
    it('cannot move a fish that is in escrow, and can once it is back', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const other = await makeTank(h, a);
      const fishId = await addFish(h, tankA);
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));

      const blocked = await call(h, a, 'POST', `/api/tanks/${tankA}/fish/${fishId}/move`, {
        toTankId: other,
      });
      expect(blocked.statusCode).toBe(404);
      expect(await fishRows(h, fishId)).toHaveLength(0);

      await call(h, a, 'POST', `/api/gifts/${id}/cancel`);
      const moved = await call(h, a, 'POST', `/api/tanks/${tankA}/fish/${fishId}/move`, {
        toTankId: other,
      });
      expect(moved.statusCode, moved.body).toBe(200);
      expect((await fishRows(h, fishId))[0]?.tankId).toBe(other);
    });

    it('hands the fish back with the hunger it had when it left, not fed by the tank', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const fishId = await addFish(h, tankA);
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));
      const held = (await offerRow(h, id)).fish as { hunger: number };
      h.clock.advance(10 * HOUR_MS);
      await call(h, a, 'POST', `/api/gifts/${id}/cancel`);
      const [after] = await fishRows(h, fishId);
      expect(after?.hunger).toBe(held.hunger);
    });
  });

  describe('authorisation', () => {
    it('hides an offer from a third party for every action', async () => {
      const a = await account(h);
      const b = await account(h);
      const c = await account(h);
      const tankA = await makeTank(h, a);
      const tankB = await makeTank(h, b);
      const tankC = await makeTank(h, c);
      const fishId = await addFish(h, tankA);
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));

      expect((await accept(h, c, id, { toTankId: tankC })).statusCode).toBe(404);
      expect((await confirm(h, c, id, tankC)).statusCode).toBe(404);
      expect((await call(h, c, 'POST', `/api/gifts/${id}/decline`)).statusCode).toBe(404);
      expect((await call(h, c, 'POST', `/api/gifts/${id}/cancel`)).statusCode).toBe(404);
      expect((await list(h, c)).incoming).toHaveLength(0);
      expect((await list(h, c)).outgoing).toHaveLength(0);
      expect((await offerRow(h, id)).status).toBe('open');
      expect(await fishRows(h, fishId)).toHaveLength(0);
      expect((await accept(h, c, randomUUID(), { toTankId: tankC })).statusCode).toBe(404);

      expect((await accept(h, a, id, { toTankId: tankA })).statusCode).toBe(404);
      expect((await call(h, b, 'POST', `/api/gifts/${id}/cancel`)).statusCode).toBe(404);
      expect((await call(h, a, 'POST', `/api/gifts/${id}/decline`)).statusCode).toBe(404);
      expect((await confirm(h, b, id, tankB)).statusCode).toBe(404);
    });

    it('rejects anonymous callers on every route', async () => {
      const id = randomUUID();
      for (const action of ['accept', 'confirm', 'decline', 'cancel']) {
        const res = await call(h, null, 'POST', `/api/gifts/${id}/${action}`, {
          toTankId: randomUUID(),
          idempotencyKey: randomUUID(),
        });
        expect(res.statusCode, action).toBe(401);
      }
    });
  });

  describe('trading', () => {
    async function trade() {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const tankA2 = await makeTank(h, a);
      const tankB = await makeTank(h, b);
      const mine = await addFish(h, tankA, { name: 'Mine' });
      const theirs = await addFish(h, tankB, { name: 'Theirs' });
      const id = offerId(
        await offer(h, a, { fromTankId: tankA, fishId: mine, to: b, wantsReturn: true }),
      );
      return { a, b, tankA, tankA2, tankB, mine, theirs, id };
    }

    it('needs a fish in return and moves nothing until the sender confirms', async () => {
      const t = await trade();
      const missing = await accept(h, t.b, t.id, { toTankId: t.tankB });
      expect(missing.statusCode).toBe(400);

      const res = await accept(h, t.b, t.id, { toTankId: t.tankB, returnFishId: t.theirs });
      expect(res.statusCode, res.body).toBe(200);
      const countered = acceptGiftResponseSchema.parse(res.json());
      expect(countered.offer.status).toBe('countered');
      expect(countered.arrival).toBeNull();
      expect(await fishRows(h, t.mine)).toHaveLength(0);
      expect((await fishRows(h, t.theirs))[0]?.tankId).toBe(t.tankB);

      const seenBySender = (await list(h, t.a)).outgoing[0];
      expect(seenBySender?.pledged).toMatchObject({ id: t.theirs, name: 'Theirs' });
    });

    it('swaps both fish when the sender confirms, once', async () => {
      const t = await trade();
      await accept(h, t.b, t.id, { toTankId: t.tankB, returnFishId: t.theirs });

      expect((await confirm(h, t.b, t.id, t.tankB)).statusCode).toBe(404);
      const key = randomUUID();
      const res = await confirm(h, t.a, t.id, t.tankA2, key);
      expect(res.statusCode, res.body).toBe(200);
      const done = confirmGiftResponseSchema.parse(res.json());
      expect(done.offer.status).toBe('accepted');
      expect(done.arrival).toMatchObject({ fishId: t.theirs, tankId: t.tankA2 });
      expect((await fishRows(h, t.mine))[0]?.tankId).toBe(t.tankB);
      expect((await fishRows(h, t.theirs))[0]?.tankId).toBe(t.tankA2);

      expect((await confirm(h, t.a, t.id, t.tankA2, key)).statusCode).toBe(200);
      const second = await confirm(h, t.a, t.id, t.tankA2);
      expect(second.statusCode).toBe(409);
      expect(errorOf(second).reason).toBe('offer_closed');
      expect(await fishRows(h, t.mine)).toHaveLength(1);
      expect(await fishRows(h, t.theirs)).toHaveLength(1);
    });

    it('refuses a confirm when the pledged fish died or left, and cancel returns the escrow', async () => {
      const t = await trade();
      await accept(h, t.b, t.id, { toTankId: t.tankB, returnFishId: t.theirs });
      await h.database.db
        .update(schema.fish)
        .set({ status: 'dead', diedAt: new Date(h.clock.now()), cause: 'old_age' })
        .where(eq(schema.fish.id, t.theirs));

      const res = await confirm(h, t.a, t.id, t.tankA2);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).reason).toBe('fish_unavailable');
      expect(await fishRows(h, t.mine)).toHaveLength(0);

      const cancel = await call(h, t.a, 'POST', `/api/gifts/${t.id}/cancel`);
      expect(cancel.statusCode).toBe(200);
      expect((await fishRows(h, t.mine))[0]?.tankId).toBe(t.tankA);
    });

    it('lets the recipient decline a countered trade without touching their pledged fish', async () => {
      const t = await trade();
      await accept(h, t.b, t.id, { toTankId: t.tankB, returnFishId: t.theirs });
      const res = await call(h, t.b, 'POST', `/api/gifts/${t.id}/decline`);
      expect(res.statusCode).toBe(200);
      expect((await fishRows(h, t.mine))[0]?.tankId).toBe(t.tankA);
      expect((await fishRows(h, t.theirs))[0]?.tankId).toBe(t.tankB);
      const late = await confirm(h, t.a, t.id, t.tankA2);
      expect(late.statusCode).toBe(409);
    });

    it('refuses a swap into a tank of the wrong biome without moving either fish', async () => {
      const t = await trade();
      const reef = await makeTank(h, t.a, { biome: 'reef' });
      await accept(h, t.b, t.id, { toTankId: t.tankB, returnFishId: t.theirs });
      const res = await confirm(h, t.a, t.id, reef);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).reason).toBe('wrong_biome');
      expect(await fishRows(h, t.mine)).toHaveLength(0);
      expect((await fishRows(h, t.theirs))[0]?.tankId).toBe(t.tankB);
      expect((await offerRow(h, t.id)).status).toBe('countered');
    });

    it('expires a countered trade and leaves the pledged fish where it is', async () => {
      const t = await trade();
      await accept(h, t.b, t.id, { toTankId: t.tankB, returnFishId: t.theirs });
      h.clock.advance(73 * HOUR_MS);
      const res = await confirm(h, t.a, t.id, t.tankA2);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).reason).toBe('offer_expired');
      expect((await fishRows(h, t.mine))[0]?.tankId).toBe(t.tankA);
      expect((await fishRows(h, t.theirs))[0]?.tankId).toBe(t.tankB);
    });

    async function countered() {
      const t = await trade();
      await accept(h, t.b, t.id, { toTankId: t.tankB, returnFishId: t.theirs });
      return t;
    }

    const swapped = async (t: Awaited<ReturnType<typeof countered>>, done: boolean) => {
      expect((await fishRows(h, t.mine))[0]?.tankId).toBe(done ? t.tankB : t.tankA);
      expect((await fishRows(h, t.theirs))[0]?.tankId).toBe(done ? t.tankA2 : t.tankB);
    };

    it('swaps once when two confirms race', async () => {
      const t = await countered();
      const results = await Promise.all([
        confirm(h, t.a, t.id, t.tankA2),
        confirm(h, t.a, t.id, t.tankA2),
      ]);
      expect(results.map((r) => r.statusCode).toSorted()).toEqual([200, 409]);
      const loser = results.find((r) => r.statusCode === 409);
      expect(loser ? errorOf(loser).reason : null).toBe('offer_closed');
      await swapped(t, true);
    });

    it('settles one way when a confirm races a cancel', async () => {
      const t = await countered();
      const [conf, can] = await Promise.all([
        confirm(h, t.a, t.id, t.tankA2),
        call(h, t.a, 'POST', `/api/gifts/${t.id}/cancel`),
      ]);
      expect([conf.statusCode, can.statusCode].toSorted()).toEqual([200, 409]);
      await swapped(t, conf.statusCode === 200);
    });

    it('settles one way when a confirm races a decline', async () => {
      const t = await countered();
      const [conf, dec] = await Promise.all([
        confirm(h, t.a, t.id, t.tankA2),
        call(h, t.b, 'POST', `/api/gifts/${t.id}/decline`),
      ]);
      expect([conf.statusCode, dec.statusCode].toSorted()).toEqual([200, 409]);
      await swapped(t, conf.statusCode === 200);
    });

    it('answers a clean 409 and returns the escrow when the recipient deleted their account', async () => {
      const t = await countered();
      const gone = await call(h, t.b, 'POST', '/api/me/delete', { password: PASSWORD });
      expect(gone.statusCode, gone.body).toBe(204);
      const res = await confirm(h, t.a, t.id, t.tankA2);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).reason).toBe('offer_closed');
      expect((await offerRow(h, t.id)).status).toBe('declined');
      expect((await fishRows(h, t.mine))[0]?.tankId).toBe(t.tankA);
    });

    it('answers a clean 409 when a recipient counter lands between the confirm pre-read and its lock', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const tankA2 = await makeTank(h, a);
      const tankB = await makeTank(h, b);
      const mine = await addFish(h, tankA, { name: 'Mine' });
      const theirs = await addFish(h, tankB, { name: 'Theirs' });
      const id = offerId(
        await offer(h, a, { fromTankId: tankA, fishId: mine, to: b, wantsReturn: true }),
      );

      const counter = await holdingLock(
        h,
        sql`select 1 from gift_offers where id = ${id} for update`,
        async (tx) => {
          await tx
            .update(schema.giftOffers)
            .set({ status: 'countered', recipientTankId: tankB, pledgedFishId: theirs })
            .where(eq(schema.giftOffers.id, id));
        },
      );
      let res;
      try {
        const pending = confirm(h, a, id, tankA2);
        await counter.whenBlocked();
        res = await pending;
      } finally {
        await counter.release();
      }
      expect(res.statusCode, res.body).toBe(409);
      expect(errorOf(res).reason).toBe('offer_changed');
      expect((await offerRow(h, id)).status).toBe('countered');
      expect(await fishRows(h, mine)).toHaveLength(0);
      expect((await fishRows(h, theirs))[0]?.tankId).toBe(tankB);

      expect((await confirm(h, a, id, tankA2)).statusCode).toBe(200);
    });

    it('tells the sender the offer closed when the recipient is deleted while the confirm waits', async () => {
      const t = await countered();
      const deletion = await holdingLock(
        h,
        sql`select 1 from "user" where id = ${t.b.userId} for update`,
        async (tx) => {
          await tx.delete(schema.ledger).where(eq(schema.ledger.userId, t.b.userId));
          await tx.delete(schema.user).where(eq(schema.user.id, t.b.userId));
        },
      );
      let res;
      try {
        const pending = confirm(h, t.a, t.id, t.tankA2);
        await deletion.whenBlocked();
        res = await pending;
      } finally {
        await deletion.release();
      }
      expect(res.statusCode, res.body).toBe(409);
      expect(errorOf(res).reason).toBe('offer_closed');
    });

    it('shows the sender a pledged fish name through the word filter', async () => {
      const t = await trade();
      await h.database.db
        .update(schema.fish)
        .set({ name: 'fuck' })
        .where(eq(schema.fish.id, t.theirs));
      await accept(h, t.b, t.id, { toTankId: t.tankB, returnFishId: t.theirs });
      expect((await list(h, t.a)).outgoing[0]?.pledged?.name).toBe('neon-tetra');
      expect((await list(h, t.b)).incoming[0]?.pledged?.name).toBe('fuck');
    });
  });

  describe('opt-in', () => {
    it('keeps tanks closed to gifts until the owner turns it on', async () => {
      const a = await account(h);
      const tank = await makeTank(h, a, { gifts: false });
      expect((await getTank(h, a, tank)).acceptsGifts).toBe(false);
      const patched = await call(h, a, 'PATCH', `/api/tanks/${tank}`, { acceptsGifts: true });
      expect(patched.statusCode, patched.body).toBe(200);
      expect(tankSchema.parse(patched.json()).acceptsGifts).toBe(true);
      expect((await getTank(h, a, tank)).acceptsGifts).toBe(true);
    });

    it('refuses an offer to a player with no open tank', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      await makeTank(h, b, { gifts: false });
      const fishId = await addFish(h, tankA);
      const res = await offer(h, a, { fromTankId: tankA, fishId, to: b, raw: true });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).reason).toBe('gifts_closed');
      expect(await fishRows(h, fishId)).toHaveLength(1);
    });

    it('refuses to accept into a closed tank and works once it is opened', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      await makeTank(h, b);
      const closedTank = await makeTank(h, b, { gifts: false });
      const fishId = await addFish(h, tankA);
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));

      const refused = await accept(h, b, id, { toTankId: closedTank });
      expect(refused.statusCode).toBe(409);
      expect(errorOf(refused).reason).toBe('gifts_closed');
      expect((await offerRow(h, id)).status).toBe('open');

      await call(h, b, 'PATCH', `/api/tanks/${closedTank}`, { acceptsGifts: true });
      expect((await accept(h, b, id, { toTankId: closedTank })).statusCode).toBe(200);
    });

    it('applies to the sender tank that receives the traded fish at confirm', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const closedA = await makeTank(h, a, { gifts: false });
      const tankB = await makeTank(h, b);
      const mine = await addFish(h, tankA);
      const theirs = await addFish(h, tankB);
      const id = offerId(
        await offer(h, a, { fromTankId: tankA, fishId: mine, to: b, wantsReturn: true }),
      );
      await accept(h, b, id, { toTankId: tankB, returnFishId: theirs });

      const refused = await confirm(h, a, id, closedA);
      expect(refused.statusCode).toBe(409);
      expect(errorOf(refused).reason).toBe('gifts_closed');
      expect((await offerRow(h, id)).status).toBe('countered');
      await call(h, a, 'PATCH', `/api/tanks/${closedA}`, { acceptsGifts: true });
      expect((await confirm(h, a, id, closedA)).statusCode).toBe(200);
    });

    it('lets a closed sender tank send, since sending moves only its own fish', async () => {
      const a = await account(h);
      const b = await account(h);
      const closedA = await makeTank(h, a, { gifts: false });
      await makeTank(h, b);
      const fishId = await addFish(h, closedA);
      expect((await offer(h, a, { fromTankId: closedA, fishId, to: b })).statusCode).toBe(201);
    });
  });

  describe('the community tank', () => {
    it('can neither send from nor receive into the ownerless community tank', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      const tankB = await makeTank(h, b);
      const [community] = await h.database.db
        .insert(schema.tanks)
        .values({ ownerId: null, name: 'Community', biome: 'freshwater', acceptsGifts: true })
        .returning();
      if (!community) throw new Error('community tank insert failed');
      const communityFish = await addFish(h, community.id);
      const mine = await addFish(h, tankA);

      const from = await offer(h, a, { fromTankId: community.id, fishId: communityFish, to: b });
      expect(from.statusCode).toBe(404);
      expect(await fishRows(h, communityFish)).toHaveLength(1);

      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId: mine, to: b }));
      const into = await accept(h, b, id, { toTankId: community.id });
      expect(into.statusCode).toBe(404);
      expect((await offerRow(h, id)).status).toBe('open');

      const tradeFish = await addFish(h, tankA);
      const trade = offerId(
        await offer(h, a, { fromTankId: tankA, fishId: tradeFish, to: b, wantsReturn: true }),
      );
      const pledge = await accept(h, b, trade, {
        toTankId: tankB,
        returnFishId: communityFish,
      });
      expect(pledge.statusCode).toBe(404);
      expect(await fishRows(h, communityFish)).toHaveLength(1);
    });
  });

  describe('names, recipients and the sweep', () => {
    it('shows another player a blocked fish name as the species, and the owner the real one', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      await makeTank(h, b);
      const fishId = await addFish(h, tankA, { name: 'fuck' });
      const res = await offer(h, a, { fromTankId: tankA, fishId, to: b });
      expect(createGiftResponseSchema.parse(res.json()).offer.fish.name).toBe('fuck');
      expect((await list(h, a)).outgoing[0]?.fish.name).toBe('fuck');
      expect((await list(h, b)).incoming[0]?.fish.name).toBe('neon-tetra');
    });

    it('404s for a recipient whose email is not verified', async () => {
      const a = await account(h);
      const b = await account(h, { verify: false });
      const tankA = await makeTank(h, a);
      const fishId = await addFish(h, tankA);
      const res = await offer(h, a, { fromTankId: tankA, fishId, to: b, raw: true });
      expect(res.statusCode).toBe(404);
      expect(await fishRows(h, fishId)).toHaveLength(1);
    });

    it('returns a fish to a tank that filled up meanwhile instead of losing it', async () => {
      const a = await account(h);
      const b = await account(h);
      const small = await makeTank(h, a, { quarantine: true });
      await makeTank(h, b);
      for (let i = 0; i < 11; i++) await addFish(h, small);
      const fishId = await addFish(h, small);
      const id = offerId(await offer(h, a, { fromTankId: small, fishId, to: b }));
      await addFish(h, small);

      const res = await call(h, a, 'POST', `/api/gifts/${id}/cancel`);
      expect(res.statusCode, res.body).toBe(200);
      expect((await fishRows(h, fishId))[0]?.tankId).toBe(small);
      expect((await getTank(h, a, small)).fish).toHaveLength(13);

      const other = await account(h);
      const tankO = await makeTank(h, other);
      const extra = await addFish(h, tankO);
      const again = offerId(await offer(h, other, { fromTankId: tankO, fishId: extra, to: a }));
      const full = await accept(h, a, again, { toTankId: small });
      expect(errorOf(full).reason).toBe('tank_full');
    });

    it('re-applies the tank medicine to a returned fish', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      await makeTank(h, b);
      const fishId = await addFish(h, tankA, {
        disease: {
          kind: 'ich',
          since: new Date(h.clock.now() - HOUR_MS).toISOString(),
          severity: 0.3,
          treatedUntil: null,
        },
      });
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));
      const until = new Date(h.clock.now() + 2 * HOUR_MS).toISOString();
      await h.database.db
        .update(schema.tanks)
        .set({ medicine: { kind: 'ich', potency: 'standard', doses: 1, until } })
        .where(eq(schema.tanks.id, tankA));

      expect((await call(h, a, 'POST', `/api/gifts/${id}/cancel`)).statusCode).toBe(200);
      const [back] = await fishRows(h, fishId);
      expect(back?.disease).toMatchObject({ kind: 'ich', treatedUntil: until });
    });

    it('keeps listing and sweeping when one stored offer is unreadable', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      await makeTank(h, b);
      const bad = await addFish(h, tankA);
      const good = await addFish(h, tankA);
      const badId = offerId(await offer(h, a, { fromTankId: tankA, fishId: bad, to: b }));
      const goodId = offerId(await offer(h, a, { fromTankId: tankA, fishId: good, to: b }));
      await h.database.db
        .update(schema.giftOffers)
        .set({ fish: {} })
        .where(eq(schema.giftOffers.id, badId));

      const seen = await list(h, b);
      expect(seen.incoming.map((o) => o.id)).toEqual([goodId]);

      h.clock.advance(73 * HOUR_MS);
      expect(await h.app.settleDueGifts()).toBeGreaterThanOrEqual(1);
      expect((await offerRow(h, goodId)).status).toBe('expired');
      expect((await fishRows(h, good))[0]?.tankId).toBe(tankA);
      expect((await offerRow(h, badId)).status).toBe('open');
      await h.database.db.delete(schema.giftOffers).where(eq(schema.giftOffers.id, badId));
    });
  });

  describe('data export', () => {
    it('lists offers sent and received, including the escrowed fish, and leaves out an unreadable one', async () => {
      const a = await account(h);
      const b = await account(h);
      const tankA = await makeTank(h, a);
      await makeTank(h, b);
      const fishId = await addFish(h, tankA, { name: 'Goldie' });
      const id = offerId(await offer(h, a, { fromTankId: tankA, fishId, to: b }));
      const brokenFish = await addFish(h, tankA);
      const brokenId = offerId(await offer(h, a, { fromTankId: tankA, fishId: brokenFish, to: b }));
      await h.database.db
        .update(schema.giftOffers)
        .set({ fish: {} })
        .where(eq(schema.giftOffers.id, brokenId));

      try {
        const mine = await call(h, a, 'POST', '/api/me/export');
        expect(mine.statusCode, mine.body).toBe(200);
        const sent = dataExportSchema.parse(mine.json()).giftOffers;
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
          id,
          role: 'sender',
          status: 'open',
          counterpart: b.handle,
          fish: { id: fishId, name: 'Goldie', species: 'neon-tetra' },
        });
        expect(mine.body).not.toContain(b.email);

        const theirs = await call(h, b, 'POST', '/api/me/export');
        const received = dataExportSchema.parse(theirs.json()).giftOffers;
        expect(received[0]).toMatchObject({ id, role: 'recipient', counterpart: a.handle });
        expect(received[0]?.['fish']).not.toHaveProperty('personality');
        expect(theirs.body).not.toContain(a.email);
        expect(received).toHaveLength(1);
      } finally {
        await h.database.db.delete(schema.giftOffers).where(eq(schema.giftOffers.id, brokenId));
      }
    });
  });
});
