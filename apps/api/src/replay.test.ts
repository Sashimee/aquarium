import {
  apiErrorSchema,
  replayResponseSchema,
  tankSchema,
  type ReplayResponse,
} from '@aquarium/shared';
import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from './db/index.ts';
import { APP_ORIGIN, createHarness, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
const DAY = 24 * 60;
const LONG_AGO = '2000-01-01T00:00:00.000Z';
let counter = 0;

async function signedIn(h: Harness): Promise<string> {
  const email = `t56-${Date.now()}-${counter++}@bas.lu`;
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
  const cookie = verify.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  if (!cookie) throw new Error('verification did not sign in');
  return cookie;
}

function call(
  h: Harness,
  cookie: string,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: object,
) {
  return h.app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie },
    ...(payload ? { payload } : {}),
  });
}

const advance = (h: Harness, minutes: number) =>
  h.app.inject({
    method: 'POST',
    url: '/api/test/advance-time',
    headers: jsonHeaders,
    payload: { minutes },
  });

async function tankWithFish(h: Harness, cookie: string, fishCount = 1) {
  const created = await call(h, cookie, 'POST', '/api/tanks', {
    name: 'Home',
    biome: 'freshwater',
  });
  const tank = tankSchema.parse(created.json());
  for (let i = 0; i < fishCount; i++) {
    const res = await call(h, cookie, 'POST', `/api/tanks/${tank.id}/fish`, {
      species: 'neon-tetra',
      name: `Blip${i}`,
    });
    expect(res.statusCode).toBe(201);
  }
  return tank;
}

const replay = (h: Harness, cookie: string, tankId: string, query: Record<string, string>) =>
  call(h, cookie, 'GET', `/api/tanks/${tankId}/replay?${new URLSearchParams(query)}`);

function parsed(res: LightMyRequestResponse): ReplayResponse {
  expect(res.statusCode, res.body).toBe(200);
  return replayResponseSchema.parse(res.json());
}

describe('away replay', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.close());

  it('requires a session', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/tanks/${randomUUID()}/replay?since=${LONG_AGO}`,
      headers: jsonHeaders,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns an empty timeline when nothing happened', async () => {
    const cookie = await signedIn(h);
    const tank = await tankWithFish(h, cookie);
    await advance(h, 60);
    const read = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
    const body = parsed(await replay(h, cookie, tank.id, { since: read.lastTickAt }));
    expect(body).toEqual({ events: [], nextCursor: null });
  });

  it('replays a starvation: sickness, then death, in time order, from away.fromAt', async () => {
    const cookie = await signedIn(h);
    const tank = await tankWithFish(h, cookie);
    await advance(h, 14 * DAY);
    const read = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
    expect(read.away?.fromAt).toBeDefined();
    const body = parsed(await replay(h, cookie, tank.id, { since: read.away?.fromAt ?? '' }));
    const kinds = body.events.map((e) => e.kind);
    expect(kinds).toContain('sick');
    expect(kinds).toContain('death');
    expect(kinds.indexOf('sick')).toBeLessThan(kinds.indexOf('death'));
    const times = body.events.map((e) => e.at);
    expect([...times].sort()).toEqual(times);
    for (const e of body.events) expect(e.tankId).toBe(tank.id);
  });

  it('survives a very long absence: capped catch-up, paged to the end without repeats', async () => {
    const cookie = await signedIn(h);
    const tank = await tankWithFish(h, cookie, 5);
    await advance(h, 300 * DAY);
    const read = tankSchema.parse((await call(h, cookie, 'GET', `/api/tanks/${tank.id}`)).json());
    expect(read.away?.capped).toBe(true);
    const since = read.away?.fromAt ?? '';
    const nowMs = h.clock.now();
    const everything = parsed(await replay(h, cookie, tank.id, { since }));
    expect(everything.events.length).toBeGreaterThan(0);
    for (const e of everything.events) {
      const atMs = Date.parse(e.at);
      expect(atMs).toBeGreaterThan(nowMs - 60 * DAY * 60_000);
      expect(atMs).toBeLessThanOrEqual(nowMs);
    }
    const deaths = everything.events.filter((e) => e.kind === 'death');
    expect(deaths.length).toBeGreaterThan(0);
    for (const death of deaths) {
      if (death.kind !== 'death') continue;
      const [row] = await h.database.db
        .select()
        .from(schema.fish)
        .where(eq(schema.fish.id, death.payload.fishId));
      expect(row?.diedAt?.toISOString()).toBe(death.at);
      const away = read.away?.deaths.find((d) => d.fishId === death.payload.fishId);
      expect(away?.diedAt).toBe(death.at);
    }
    const [first] = deaths;
    if (first?.kind !== 'death') throw new Error('expected a death event');
    const netted = await call(
      h,
      cookie,
      'DELETE',
      `/api/tanks/${tank.id}/fish/${first.payload.fishId}`,
    );
    expect(netted.statusCode).toBe(200);
    const after = tankSchema.parse(netted.json());
    expect(after.memorials.map((m) => m.diedAt)).toEqual([first.at]);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const body = parsed(
        await replay(h, cookie, tank.id, { since, limit: '2', ...(cursor ? { cursor } : {}) }),
      );
      expect(body.events.length).toBeLessThanOrEqual(2);
      seen.push(...body.events.map((e) => e.id));
      cursor = body.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 50);
    expect(cursor).toBeUndefined();
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(new Set(seen).size).toBe(seen.length);
    const full = parsed(await replay(h, cookie, tank.id, { since }));
    expect(full.events.map((e) => e.id)).toEqual(seen);
  });

  it('orders events at the same instant by id and pages without gaps or repeats', async () => {
    const cookie = await signedIn(h);
    const tank = await tankWithFish(h, cookie);
    const at = new Date(h.clock.now() - 1000);
    await h.database.db.insert(schema.events).values(
      Array.from({ length: 5 }, () => ({
        tankId: tank.id,
        at,
        kind: 'water_change' as const,
        payload: {},
      })),
    );
    const since = new Date(at.getTime() - 1).toISOString();
    const all = parsed(await replay(h, cookie, tank.id, { since }));
    const ids = all.events.map((e) => e.id);
    expect(ids).toHaveLength(5);
    expect(ids).toEqual([...ids].sort());
    const first = parsed(await replay(h, cookie, tank.id, { since, limit: '2' }));
    const second = parsed(
      await replay(h, cookie, tank.id, { since, limit: '10', cursor: first.nextCursor ?? '' }),
    );
    expect([...first.events, ...second.events].map((e) => e.id)).toEqual(ids);
    expect(second.nextCursor).toBeNull();
  });

  it('pages one event at a time through rows stamped with microseconds', async () => {
    const cookie = await signedIn(h);
    const tank = await tankWithFish(h, cookie);
    const base = new Date(h.clock.now() - 10_000).toISOString();
    await h.database.db.insert(schema.events).values(
      [100, 200, 300, 400].map((us) => ({
        tankId: tank.id,
        at: sql`${base}::timestamptz + ${us} * interval '1 microsecond'`,
        kind: 'water_change' as const,
        payload: {},
      })),
    );
    const since = new Date(Date.parse(base) - 1).toISOString();
    const all = parsed(await replay(h, cookie, tank.id, { since }));
    expect(all.events).toHaveLength(4);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const body = parsed(
        await replay(h, cookie, tank.id, { since, limit: '1', ...(cursor ? { cursor } : {}) }),
      );
      seen.push(...body.events.map((e) => e.id));
      cursor = body.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(cursor).toBeUndefined();
    expect(seen).toEqual(all.events.map((e) => e.id));
  });

  it('treats since as exclusive and until as inclusive', async () => {
    const cookie = await signedIn(h);
    const tank = await tankWithFish(h, cookie);
    const at = new Date(h.clock.now() - 5000);
    await h.database.db
      .insert(schema.events)
      .values({ tankId: tank.id, at, kind: 'water_change', payload: {} });
    const iso = at.toISOString();
    const before = new Date(at.getTime() - 1).toISOString();
    expect(parsed(await replay(h, cookie, tank.id, { since: iso })).events).toHaveLength(0);
    expect(parsed(await replay(h, cookie, tank.id, { since: before })).events).toHaveLength(1);
    expect(
      parsed(await replay(h, cookie, tank.id, { since: before, until: iso })).events,
    ).toHaveLength(1);
    expect(
      parsed(await replay(h, cookie, tank.id, { since: before, until: before })).events,
    ).toHaveLength(0);
  });

  it("returns 404 for another user's tank and leaks nothing", async () => {
    const owner = await signedIn(h);
    const tank = await tankWithFish(h, owner);
    await h.database.db
      .insert(schema.events)
      .values({ tankId: tank.id, kind: 'water_change', payload: {} });
    const other = await signedIn(h);
    const res = await replay(h, other, tank.id, { since: LONG_AGO });
    expect(res.statusCode).toBe(404);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('not_found');
    expect(parsed(await replay(h, owner, tank.id, { since: LONG_AGO })).events).toHaveLength(1);
  });

  it('rejects malformed since, limit and cursor with 400', async () => {
    const cookie = await signedIn(h);
    const tank = await tankWithFish(h, cookie);
    for (const query of [
      {},
      { since: 'yesterday' },
      { since: LONG_AGO, limit: '0' },
      { since: LONG_AGO, limit: '501' },
      { since: LONG_AGO, cursor: 'not a cursor!' },
      { since: LONG_AGO, cursor: Buffer.from('nope').toString('base64url') },
      {
        since: LONG_AGO,
        cursor: Buffer.from(
          '2026-01-01T00:00:00.000000Z|00000000-0000-4000-8000-000000000000|extra',
        ).toString('base64url'),
      },
    ]) {
      const res = await replay(h, cookie, tank.id, query);
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
    }
  });

  it('is rate limited per user', async () => {
    await h.close();
    h = await createHarness({
      careLimits: {
        feed: { max: 6, windowMs: 60_000 },
        care: { max: 5, windowMs: 60_000 },
        ate: { max: 4, windowMs: 60_000 },
        addFish: { max: 100, windowMs: 60_000 },
        replay: { max: 2, windowMs: 60_000 },
      },
    });
    const cookie = await signedIn(h);
    const tank = await tankWithFish(h, cookie);
    expect((await replay(h, cookie, tank.id, { since: LONG_AGO })).statusCode).toBe(200);
    expect((await replay(h, cookie, tank.id, { since: LONG_AGO })).statusCode).toBe(200);
    const limited = await replay(h, cookie, tank.id, { since: LONG_AGO });
    expect(limited.statusCode).toBe(429);
    expect(apiErrorSchema.parse(limited.json()).error.code).toBe('rate_limited');
  });
});
