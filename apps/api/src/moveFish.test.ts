import { randomUUID } from 'node:crypto';
import {
  apiErrorSchema,
  moveFishResponseSchema,
  replayResponseSchema,
  tankSchema,
  type Tank,
} from '@aquarium/shared';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from './db/index.ts';
import { DEFAULT_CARE_LIMITS } from './tanks.ts';
import { APP_ORIGIN, createHarness, fishPayload, topUp, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
const HOUR_MS = 3_600_000;
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

interface Account {
  cookie: string;
  userId: string;
}

async function account(h: Harness): Promise<Account> {
  const email = `t39-${Date.now()}-${counter++}@bas.lu`;
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

const error = (res: LightMyRequestResponse) => apiErrorSchema.parse(res.json()).error;

async function makeTank(
  h: Harness,
  who: Account,
  body: { biome?: 'freshwater' | 'reef' | 'mangrove'; quarantine?: boolean; size?: string } = {},
): Promise<string> {
  await topUp(h);
  const res = await call(h, who, 'POST', '/api/tanks', {
    name: 'Tank',
    idempotencyKey: randomUUID(),
    biome: body.biome ?? 'freshwater',
    ...(body.quarantine ? { quarantine: true, size: 'nano30' } : {}),
    ...(body.size ? { size: body.size } : {}),
  });
  expect(res.statusCode).toBe(201);
  return tankSchema.parse(res.json()).id;
}

interface FishOptions {
  status?: 'alive' | 'dead';
  disease?: { kind: 'ich' | 'fin-rot' | 'velvet'; severity: number } | null;
  introducedAt?: Date | null;
  species?: string;
}

async function addFish(h: Harness, tankId: string, opts: FishOptions = {}): Promise<string> {
  const dead = opts.status === 'dead';
  const [row] = await h.database.db
    .insert(schema.fish)
    .values({
      tankId,
      species: opts.species ?? 'neon-tetra',
      name: 'Pip',
      sex: 'female',
      size: 0.03,
      personality: { boldness: 0.6, greed: 0.4, sociability: 0.5 },
      health: 0.8,
      status: opts.status ?? 'alive',
      diedAt: dead ? new Date(h.clock.now()) : null,
      cause: dead ? 'old_age' : null,
      introducedAt: opts.introducedAt === undefined ? new Date(h.clock.now()) : opts.introducedAt,
      disease: opts.disease
        ? {
            kind: opts.disease.kind,
            since: new Date(h.clock.now()).toISOString(),
            severity: opts.disease.severity,
            treatedUntil: null,
          }
        : null,
    })
    .returning();
  if (!row) throw new Error('fish insert failed');
  return row.id;
}

const move = (h: Harness, who: Account, from: string, fishId: string, body: object) =>
  call(h, who, 'POST', `/api/tanks/${from}/fish/${fishId}/move`, body);

const getTank = async (h: Harness, who: Account, tankId: string): Promise<Tank> => {
  const res = await call(h, who, 'GET', `/api/tanks/${tankId}`);
  expect(res.statusCode).toBe(200);
  return tankSchema.parse(res.json());
};

const fishRow = async (h: Harness, id: string) => {
  const [row] = await h.database.db.select().from(schema.fish).where(eq(schema.fish.id, id));
  if (!row) throw new Error('fish missing');
  return row;
};

describe('moving a fish between tanks', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  describe('authorisation and input', () => {
    it('refuses an anonymous caller', async () => {
      const res = await move(h, { cookie: '', userId: '' }, randomUUID(), randomUUID(), {
        toTankId: randomUUID(),
      });
      expect(res.statusCode).toBe(401);
    });

    it("404s on another player's tank, source or destination, without leaking it exists", async () => {
      const owner = await account(h);
      const stranger = await account(h);
      const a = await makeTank(h, owner);
      const fishId = await addFish(h, a);
      const strangerTank = await makeTank(h, stranger);

      expect((await move(h, stranger, a, fishId, { toTankId: strangerTank })).statusCode).toBe(404);
      expect((await move(h, owner, a, fishId, { toTankId: strangerTank })).statusCode).toBe(404);
      expect((await move(h, owner, a, fishId, { toTankId: randomUUID() })).statusCode).toBe(404);
      expect((await fishRow(h, fishId)).tankId).toBe(a);
    });

    it('404s on a fish that is not in the source tank', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const b = await makeTank(h, who);
      const inB = await addFish(h, b);
      expect((await move(h, who, a, inB, { toTankId: b })).statusCode).toBe(404);
      expect((await move(h, who, a, randomUUID(), { toTankId: b })).statusCode).toBe(404);
    });

    it.each([{}, { toTankId: 'nope' }, { toTankId: randomUUID(), extra: 1 }])(
      'rejects the body %j',
      async (body) => {
        const who = await account(h);
        const a = await makeTank(h, who);
        const fishId = await addFish(h, a);
        expect((await move(h, who, a, fishId, body)).statusCode).toBe(400);
      },
    );

    it('rejects moving a fish into the tank it is in', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const fishId = await addFish(h, a);
      const res = await move(h, who, a, fishId, { toTankId: a });
      expect(res.statusCode).toBe(400);
      expect(error(res).code).toBe('validation_failed');
    });

    it('rate limits like other care actions', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const b = await makeTank(h, who);
      const fishId = await addFish(h, a);
      const codes = new Set<number>();
      let from = a;
      let to = b;
      for (let i = 0; i < 70; i++) {
        const res = await move(h, who, from, fishId, {
          toTankId: to,
          idempotencyKey: randomUUID(),
        });
        codes.add(res.statusCode);
        [from, to] = [to, from];
      }
      expect(codes.has(429)).toBe(true);
    });
  });

  describe('idempotent replay before the rate limit', () => {
    it('replays a move retried past the care limit instead of answering 429', async () => {
      const limited = await createHarness({
        careLimits: { ...DEFAULT_CARE_LIMITS, care: { max: 1, windowMs: 60_000 } },
      });
      try {
        const who = await account(limited);
        const a = await makeTank(limited, who);
        const b = await makeTank(limited, who);
        const fishId = await addFish(limited, a);
        const body = { toTankId: b, idempotencyKey: randomUUID() };
        expect((await move(limited, who, a, fishId, body)).statusCode).toBe(200);
        const retry = await move(limited, who, a, fishId, body);
        expect(retry.statusCode).toBe(200);
        expect(moveFishResponseSchema.parse(retry.json()).destination.fish).toHaveLength(1);
        const fresh = await move(limited, who, b, fishId, {
          toTankId: a,
          idempotencyKey: randomUUID(),
        });
        expect(fresh.statusCode).toBe(429);
      } finally {
        await limited.close();
      }
    });
  });

  describe('refusals', () => {
    it('will not move a dead fish', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const b = await makeTank(h, who);
      const fishId = await addFish(h, a, { status: 'dead' });
      const res = await move(h, who, a, fishId, { toTankId: b });
      expect(res.statusCode).toBe(409);
      expect(error(res).reason).toBe('fish_dead');
    });

    it('will not move a freshwater fish into a reef tank', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const reef = await makeTank(h, who, { biome: 'reef' });
      const fishId = await addFish(h, a);
      const res = await move(h, who, a, fishId, { toTankId: reef });
      expect(res.statusCode).toBe(409);
      expect(error(res).reason).toBe('wrong_biome');
      expect((await fishRow(h, fishId)).tankId).toBe(a);
    });

    it('will not move a silver mono into a tank shorter than 150 cm', async () => {
      const who = await account(h);
      const long = await makeTank(h, who, { biome: 'mangrove', size: 'long300' });
      const standard = await makeTank(h, who, { biome: 'mangrove' });
      const fishId = await addFish(h, long, { species: 'silver-mono' });
      const res = await move(h, who, long, fishId, { toTankId: standard });
      expect(res.statusCode).toBe(409);
      expect(error(res).message).toContain('150 cm');
      expect((await fishRow(h, fishId)).tankId).toBe(long);
      const events = await h.database.db
        .select()
        .from(schema.events)
        .where(eq(schema.events.kind, 'fish_moved'));
      expect(events.filter((e) => e.tankId === long || e.tankId === standard)).toHaveLength(0);
    });

    it('lets a silver mono into the quarantine tank, which is always short', async () => {
      const who = await account(h);
      const long = await makeTank(h, who, { biome: 'mangrove', size: 'long300' });
      const quarantine = await makeTank(h, who, { biome: 'mangrove', quarantine: true });
      const fishId = await addFish(h, long, { species: 'silver-mono' });
      const res = await move(h, who, long, fishId, { toTankId: quarantine });
      expect(res.statusCode, res.body).toBe(200);
      expect((await fishRow(h, fishId)).tankId).toBe(quarantine);
    });

    it('will not move a fish into a full tank', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const q = await makeTank(h, who, { quarantine: true });
      for (let i = 0; i < 12; i++) await addFish(h, q);
      const fishId = await addFish(h, a);
      const res = await move(h, who, a, fishId, { toTankId: q });
      expect(res.statusCode).toBe(409);
      expect(error(res).reason).toBe('tank_full');
      expect((await fishRow(h, fishId)).tankId).toBe(a);
    });
  });

  describe('a successful move', () => {
    it('keeps the fish and returns both tanks', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const q = await makeTank(h, who, { quarantine: true });
      const fishId = await addFish(h, a, { disease: { kind: 'ich', severity: 0.3 } });
      const before = await fishRow(h, fishId);

      const res = await move(h, who, a, fishId, { toTankId: q });
      expect(res.statusCode).toBe(200);
      const body = moveFishResponseSchema.parse(res.json());
      expect(body.source.id).toBe(a);
      expect(body.destination.id).toBe(q);
      expect(body.source.fish.map((f) => f.id)).not.toContain(fishId);
      const moved = body.destination.fish.find((f) => f.id === fishId);
      expect(moved).toMatchObject({
        name: before.name,
        tankId: q,
        status: 'alive',
        disease: { kind: 'ich', treatedUntil: null },
      });
      expect(moved?.bornAt).toBe(before.bornAt.toISOString());
      expect(moved?.personality).toEqual(before.personality);
      expect(moved?.health).toBeCloseTo(0.8, 2);
    });

    it('catches both tanks up to now before the move', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const q = await makeTank(h, who, { quarantine: true });
      const fishId = await addFish(h, a);
      h.clock.advance(3 * HOUR_MS);
      const res = await move(h, who, a, fishId, { toTankId: q });
      const body = moveFishResponseSchema.parse(res.json());
      expect(Date.parse(body.source.lastTickAt)).toBeGreaterThan(h.clock.now() - 20 * 60_000);
      expect(Date.parse(body.destination.lastTickAt)).toBeGreaterThan(h.clock.now() - 20 * 60_000);
      expect(body.source.away).toBeDefined();
      expect(body.destination.away).toBeDefined();
    });

    it("treats the sick fish with the destination's medicine, and stops when it leaves", async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const q = await makeTank(h, who, { quarantine: true });
      const fishId = await addFish(h, a, { disease: { kind: 'ich', severity: 0.3 } });
      await addFish(h, q, { disease: { kind: 'ich', severity: 0.2 } });
      const dosed = await call(h, who, 'POST', `/api/tanks/${q}/treat`, {
        kind: 'ich',
        idempotencyKey: randomUUID(),
      });
      expect(dosed.statusCode).toBe(200);
      const until = (await getTank(h, who, q)).medicine?.until;
      expect(until).toBeDefined();

      const into = moveFishResponseSchema.parse(
        (await move(h, who, a, fishId, { toTankId: q })).json(),
      );
      expect(into.destination.fish.find((f) => f.id === fishId)?.disease?.treatedUntil).toBe(until);

      const out = moveFishResponseSchema.parse(
        (await move(h, who, q, fishId, { toTankId: a })).json(),
      );
      expect(out.destination.fish.find((f) => f.id === fishId)?.disease?.treatedUntil).toBeNull();
    });

    it('counts the fish as new in the destination, and settled again when it goes back', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const q = await makeTank(h, who, { quarantine: true });
      const boughtAt = new Date(h.clock.now() - 30 * 86_400_000);
      const fishId = await addFish(h, a, { introducedAt: boughtAt });

      h.clock.advance(HOUR_MS);
      await move(h, who, a, fishId, { toTankId: q });
      expect(
        Math.abs(((await fishRow(h, fishId)).introducedAt?.getTime() ?? 0) - h.clock.now()),
      ).toBeLessThan(1000);

      h.clock.advance(HOUR_MS);
      await move(h, who, q, fishId, { toTankId: a });
      expect((await fishRow(h, fishId)).introducedAt?.getTime()).toBe(boughtAt.getTime());
    });

    it('restores a null introduction (born in the tank) when the fish goes back', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const q = await makeTank(h, who, { quarantine: true });
      const fishId = await addFish(h, a, { introducedAt: null });
      await move(h, who, a, fishId, { toTankId: q });
      await move(h, who, q, fishId, { toTankId: a });
      expect((await fishRow(h, fishId)).introducedAt).toBeNull();
    });

    it('logs a fish_moved event in each tank and includes it in the replay', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const q = await makeTank(h, who, { quarantine: true });
      const fishId = await addFish(h, a);
      const since = new Date(h.clock.now() - 1000).toISOString();
      await move(h, who, a, fishId, { toTankId: q });

      const directionIn = async (tankId: string) => {
        const rows = await h.database.db
          .select()
          .from(schema.events)
          .where(and(eq(schema.events.tankId, tankId), eq(schema.events.kind, 'fish_moved')));
        return rows.map((e) => e.payload);
      };
      expect(await directionIn(a)).toEqual([{ fishId, direction: 'out', otherTankId: q }]);
      expect(await directionIn(q)).toEqual([{ fishId, direction: 'in', otherTankId: a }]);
      const replay = await call(
        h,
        who,
        'GET',
        `/api/tanks/${a}/replay?since=${encodeURIComponent(since)}`,
      );
      expect(replay.statusCode).toBe(200);
      const parsed = replayResponseSchema.parse(replay.json());
      expect(parsed.events.map((e) => e.kind)).toContain('fish_moved');
    });
  });

  describe('idempotency', () => {
    it('replays the first answer for the same key and moves the fish once', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const q = await makeTank(h, who, { quarantine: true });
      const fishId = await addFish(h, a);
      const body = { toTankId: q, idempotencyKey: randomUUID() };
      const first = await move(h, who, a, fishId, body);
      const again = await move(h, who, a, fishId, body);
      expect(first.statusCode).toBe(200);
      expect(again.statusCode).toBe(200);
      expect(moveFishResponseSchema.parse(again.json()).destination.fish.map((f) => f.id)).toEqual([
        fishId,
      ]);
      const out = await h.database.db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.tankId, a), eq(schema.events.kind, 'fish_moved')));
      expect(out).toHaveLength(1);
    });

    it('refuses a key reused for another fish or destination', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const q = await makeTank(h, who, { quarantine: true });
      const c = await makeTank(h, who);
      const one = await addFish(h, a);
      const two = await addFish(h, a);
      const idempotencyKey = randomUUID();
      expect((await move(h, who, a, one, { toTankId: q, idempotencyKey })).statusCode).toBe(200);

      const otherFish = await move(h, who, a, two, { toTankId: q, idempotencyKey });
      expect(otherFish.statusCode).toBe(409);
      expect(error(otherFish).reason).toBe('key_reused');
      const otherTank = await move(h, who, a, one, { toTankId: c, idempotencyKey });
      expect(otherTank.statusCode).toBe(409);
      expect((await fishRow(h, two)).tankId).toBe(a);
    });

    it('refuses a key already spent by a move in the other direction', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const q = await makeTank(h, who, { quarantine: true });
      const fishId = await addFish(h, a);
      const idempotencyKey = randomUUID();
      expect((await move(h, who, a, fishId, { toTankId: q, idempotencyKey })).statusCode).toBe(200);

      const back = await move(h, who, q, fishId, { toTankId: a, idempotencyKey });
      expect(back.statusCode).toBe(409);
      expect(error(back).reason).toBe('key_reused');
      expect((await fishRow(h, fishId)).tankId).toBe(q);
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of two simultaneous moves of the same fish win', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const b = await makeTank(h, who);
      const c = await makeTank(h, who);
      const fishId = await addFish(h, a);
      const results = await Promise.all([
        move(h, who, a, fishId, { toTankId: b }),
        move(h, who, a, fishId, { toTankId: c }),
      ]);
      expect(results.map((r) => r.statusCode).toSorted()).toEqual([200, 404]);
      const rows = await h.database.db.select().from(schema.fish).where(eq(schema.fish.id, fishId));
      expect(rows).toHaveLength(1);
      expect([b, c]).toContain(rows[0]?.tankId);
    });

    it('never overfills a destination with one free slot', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const q = await makeTank(h, who, { quarantine: true });
      for (let i = 0; i < 11; i++) await addFish(h, q);
      const one = await addFish(h, a);
      const two = await addFish(h, a);
      const results = await Promise.all([
        move(h, who, a, one, { toTankId: q }),
        move(h, who, a, two, { toTankId: q }),
      ]);
      expect(results.map((r) => r.statusCode).toSorted()).toEqual([200, 409]);
      expect((await getTank(h, who, q)).fish).toHaveLength(12);
      expect((await getTank(h, who, a)).fish).toHaveLength(1);
    });

    it('does not deadlock when the source catch-up claims a reward while the destination is busy', async () => {
      const grownUp = new Date(h.clock.now() - 400 * 24 * HOUR_MS);
      for (let round = 0; round < 8; round++) {
        const who = await account(h);
        const first = await makeTank(h, who);
        const second = await makeTank(h, who);
        const [source, destination] = [first, second].toSorted() as [string, string];
        const fishId = await addFish(h, source);
        await h.database.db
          .update(schema.fish)
          .set({ stage: 'juvenile', bornAt: grownUp })
          .where(eq(schema.fish.id, fishId));
        h.clock.advance(HOUR_MS);

        const results = await Promise.all([
          move(h, who, source, fishId, { toTankId: destination }),
          call(
            h,
            who,
            'POST',
            `/api/tanks/${destination}/fish`,
            fishPayload('neon-tetra', 'Buyer'),
          ),
          call(h, who, 'POST', `/api/tanks/${destination}/care`, {
            type: 'bottled_bacteria',
            idempotencyKey: randomUUID(),
          }),
        ]);
        expect(results.map((r) => r.statusCode)).toEqual([200, 201, 200]);
        expect((await fishRow(h, fishId)).tankId).toBe(destination);
      }
    }, 60_000);

    it('survives opposite moves of two fish at once without deadlock or loss', async () => {
      const who = await account(h);
      const a = await makeTank(h, who);
      const b = await makeTank(h, who);
      const inA = await addFish(h, a);
      const inB = await addFish(h, b);
      const results = await Promise.all([
        move(h, who, a, inA, { toTankId: b }),
        move(h, who, b, inB, { toTankId: a }),
      ]);
      expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
      expect((await fishRow(h, inA)).tankId).toBe(b);
      expect((await fishRow(h, inB)).tankId).toBe(a);
    });
  });
});
