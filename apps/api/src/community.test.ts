import { randomUUID } from 'node:crypto';
import {
  apiErrorSchema,
  COMMUNITY_TANK_FEED_CAP,
  COMMUNITY_USER_FEED_QUOTA,
  communityEventSchema,
  communityFeedResponseSchema,
  communityStateSchema,
  communityStreamStateSchema,
  dataExportSchema,
} from '@aquarium/shared';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { secondsUntilRoom } from './community.ts';
import { schema } from './db/index.ts';
import { APP_ORIGIN, createHarness, type Harness, type HarnessOptions } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
const HOUR = 3_600_000;
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

async function signedIn(h: Harness): Promise<string> {
  const email = `community-${Date.now()}-${counter++}@bas.lu`;
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
  return cookie;
}

const post = (h: Harness, cookie: string | null, url: string, payload: object) =>
  h.app.inject({
    method: 'POST',
    url,
    headers: { ...jsonHeaders, ...(cookie ? { cookie } : {}) },
    payload,
  });

const feed = (
  h: Harness,
  cookie: string | null,
  portion = 0.5,
  key: string = randomUUID(),
  food = 'flakes',
) => post(h, cookie, '/api/community/feed', { food, portion, idempotencyKey: key });

const getState = (h: Harness, cookie?: string) =>
  h.app.inject({ method: 'GET', url: '/api/community', headers: cookie ? { cookie } : {} });

const advance = (h: Harness, ms: number) =>
  h.app.inject({
    method: 'POST',
    url: '/api/test/advance-time',
    headers: jsonHeaders,
    payload: { minutes: ms / 60_000 },
  });

const errorCode = (res: LightMyRequestResponse) => apiErrorSchema.parse(res.json()).error.code;

interface Frame {
  event: string;
  data: unknown;
}

interface Sse {
  status: number;
  headers: Headers;
  frames: Frame[];
  next(event: string, after?: number): Promise<Frame>;
  closed: Promise<void>;
  close(): void;
}

const refusedStream = (): never => {
  throw new Error('the stream was refused');
};

async function openStream(base: string, init: { cookie?: string; ip?: string } = {}): Promise<Sse> {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/community/stream`, {
    signal: ctl.signal,
    headers: {
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.ip ? { 'x-forwarded-for': init.ip } : {}),
    },
  });
  const frames: Frame[] = [];
  const waiters: (() => void)[] = [];
  let done = () => {};
  const closed = new Promise<void>((resolve) => (done = resolve));
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel();
    done();
    return {
      status: res.status,
      headers: res.headers,
      frames,
      next: async () => refusedStream(),
      closed,
      close() {},
    };
  }
  const reader = res.body.getReader();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf('\n\n');
        while (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name && data) frames.push({ event: name, data: JSON.parse(data) as unknown });
          end = buffer.indexOf('\n\n');
        }
        for (const wake of waiters.splice(0)) wake();
      }
    } catch {
      // the test aborted the request
    }
    done();
    for (const wake of waiters.splice(0)) wake();
  })();
  const next = async (event: string, after = 0): Promise<Frame> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const found = frames.slice(after).find((f) => f.event === event);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`no "${event}" frame; got ${frames.map((f) => f.event).join(',')}`);
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  return { status: 200, headers: res.headers, frames, next, closed, close: () => ctl.abort() };
}

describe('community tank', () => {
  let h: Harness | undefined;
  const opened: Sse[] = [];

  afterEach(async () => {
    for (const s of opened.splice(0)) s.close();
    await h?.close();
    h = undefined;
  });

  async function start(opts: HarnessOptions = {}): Promise<Harness> {
    h = await createHarness(opts);
    return h;
  }

  async function listen(harness: Harness): Promise<string> {
    await harness.app.listen({ port: 0, host: '127.0.0.1' });
    const address = harness.app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    return `http://127.0.0.1:${address.port}`;
  }

  async function watch(base: string, init: { cookie?: string; ip?: string } = {}) {
    const s = await openStream(base, init);
    opened.push(s);
    return s;
  }

  describe('reading and feeding', () => {
    it('lets an anonymous viewer read the tank but not feed it', async () => {
      const harness = await start();
      const res = await getState(harness);
      expect(res.statusCode).toBe(200);
      const state = communityStateSchema.parse(res.json());
      expect(state.quota).toBeNull();
      expect(state.tank.fish).toHaveLength(13);
      expect(state.tank.fish.every((f) => f.status === 'alive')).toBe(true);
      expect(state.tankFeedRemaining).toBe(COMMUNITY_TANK_FEED_CAP.portions);
      expect(res.body).not.toContain('ownerId');
      expect((await feed(harness, null)).statusCode).toBe(401);
      const ate = await post(harness, null, '/api/community/ate', {
        reports: [{ fishId: randomUUID(), portion: 0.1, at: new Date().toISOString() }],
      });
      expect(ate.statusCode).toBe(401);
    });

    it('refuses an account that has not verified its email', async () => {
      const harness = await start();
      const signedUp = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: jsonHeaders,
        payload: {
          email: `community-unverified-${Date.now()}@bas.lu`,
          password: PASSWORD,
          name: 'Tester',
          callbackURL: '/verify-email',
        },
      });
      const res = await feed(harness, cookieOf(signedUp));
      expect([401, 403]).toContain(res.statusCode);
    });

    it('seeds exactly one tank even when the first requests race', async () => {
      const harness = await start();
      await Promise.all(Array.from({ length: 6 }, () => getState(harness)));
      const tanks = await harness.database.db.select().from(schema.tanks);
      expect(tanks).toHaveLength(1);
      expect(tanks[0]?.ownerId).toBeNull();
      const registered = await harness.database.db.select().from(schema.communityTank);
      expect(registered).toHaveLength(1);
    });

    it('keeps the community tank out of every user tank route', async () => {
      const harness = await start();
      const cookie = await signedIn(harness);
      const state = communityStateSchema.parse((await getState(harness, cookie)).json());
      const list = await harness.app.inject({
        method: 'GET',
        url: '/api/tanks',
        headers: { cookie },
      });
      expect(list.json()).toEqual([]);
      const direct = await harness.app.inject({
        method: 'GET',
        url: `/api/tanks/${state.tank.id}`,
        headers: { cookie },
      });
      expect(direct.statusCode).toBe(404);
    });

    it('feeds through the nutrient model and records a feed event', async () => {
      const harness = await start();
      const cookie = await signedIn(harness);
      const before = communityStateSchema.parse((await getState(harness)).json());
      const res = await feed(harness, cookie, 0.5);
      expect(res.statusCode).toBe(201);
      const body = communityFeedResponseSchema.parse(res.json());
      expect(body.replayed).toBe(false);
      expect(body.state.tank.water.uneatenFood).toBeGreaterThan(before.tank.water.uneatenFood);
      expect(body.state.quota).toMatchObject({ used: 0.5, remaining: 1.5 });
      expect(body.state.tankFeedRemaining).toBeCloseTo(COMMUNITY_TANK_FEED_CAP.portions - 0.5);
      const events = await harness.database.db
        .select()
        .from(schema.events)
        .where(eq(schema.events.tankId, before.tank.id));
      expect(events.filter((e) => e.kind === 'feed')).toHaveLength(1);
    });

    it('lets fed fish eat, and rejects reports of more than was dropped', async () => {
      const harness = await start();
      const cookie = await signedIn(harness);
      await feed(harness, cookie, 1);
      const state = communityStateSchema.parse((await getState(harness)).json());
      const fishId = state.tank.fish[0]?.id ?? '';
      const at = new Date(harness.clock.now()).toISOString();
      const ate = await post(harness, cookie, '/api/community/ate', {
        reports: [{ fishId, portion: 0.4, at }],
      });
      expect(ate.statusCode).toBe(200);
      const after = communityStateSchema.parse(ate.json());
      expect(after.tank.water.uneatenFood).toBeLessThan(state.tank.water.uneatenFood);
      const greedy = await post(harness, cookie, '/api/community/ate', {
        reports: [{ fishId, portion: 5, at }],
      });
      expect(greedy.statusCode).toBe(422);
      expect(errorCode(greedy)).toBe('feeding_rejected');
    });
  });

  describe('quota', () => {
    it('allows the whole share, then answers 429 with retry-after', async () => {
      const harness = await start();
      const cookie = await signedIn(harness);
      for (let i = 0; i < COMMUNITY_USER_FEED_QUOTA.portions / 0.5; i++) {
        expect((await feed(harness, cookie, 0.5)).statusCode).toBe(201);
      }
      const over = await feed(harness, cookie, 0.5);
      expect(over.statusCode).toBe(429);
      expect(errorCode(over)).toBe('quota_exceeded');
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(over.headers['retry-after'])).toBeLessThanOrEqual(
        COMMUNITY_USER_FEED_QUOTA.windowMs / 1000,
      );
    });

    it('stops at the exact boundary with the smallest portion', async () => {
      const harness = await start();
      const cookie = await signedIn(harness);
      expect((await feed(harness, cookie, 1)).statusCode).toBe(201);
      expect((await feed(harness, cookie, 0.9)).statusCode).toBe(201);
      expect((await feed(harness, cookie, 0.1)).statusCode).toBe(201);
      expect((await feed(harness, cookie, 0.1)).statusCode).toBe(429);
      const state = communityStateSchema.parse((await getState(harness, cookie)).json());
      expect(state.quota?.remaining).toBeCloseTo(0);
      expect(state.quota?.resetsAt).not.toBeNull();
    });

    it('does not burn quota on a rejected feed and leaves other users untouched', async () => {
      const harness = await start();
      const a = await signedIn(harness);
      const b = await signedIn(harness);
      await feed(harness, a, 1);
      await feed(harness, a, 1);
      expect((await feed(harness, a, 0.1)).statusCode).toBe(429);
      const untouched = communityStateSchema.parse((await getState(harness, b)).json());
      expect(untouched.quota?.used).toBe(0);
      expect(await harness.database.db.select().from(schema.communityFeeds)).toHaveLength(2);
    });

    it('opens again once the window has passed', async () => {
      const harness = await start();
      const cookie = await signedIn(harness);
      await feed(harness, cookie, 1);
      await feed(harness, cookie, 1);
      expect((await feed(harness, cookie, 1)).statusCode).toBe(429);
      await advance(harness, COMMUNITY_USER_FEED_QUOTA.windowMs + 60_000);
      expect((await feed(harness, cookie, 1)).statusCode).toBe(201);
      const state = communityStateSchema.parse((await getState(harness, cookie)).json());
      expect(state.quota?.used).toBe(1);
    });

    it('caps the whole tank across users, and lifts the cap after its window', async () => {
      const harness = await start();
      const a = await signedIn(harness);
      const b = await signedIn(harness);
      const c = await signedIn(harness);
      expect((await feed(harness, a, 1)).statusCode).toBe(201);
      expect((await feed(harness, a, 1)).statusCode).toBe(201);
      expect((await feed(harness, b, 1)).statusCode).toBe(201);
      const full = await feed(harness, c, 0.1);
      expect(full.statusCode).toBe(429);
      expect(errorCode(full)).toBe('quota_exceeded');
      expect(Number(full.headers['retry-after'])).toBeGreaterThan(0);
      const state = communityStateSchema.parse((await getState(harness, c)).json());
      expect(state.tankFeedRemaining).toBeCloseTo(0);
      expect(state.quota?.used).toBe(0);
      await advance(harness, COMMUNITY_TANK_FEED_CAP.windowMs + 60_000);
      expect((await feed(harness, c, 0.5)).statusCode).toBe(201);
    });

    it('computes the wait until enough old feeds leave the window', () => {
      const t0 = 1_000_000_000;
      const rows = [
        { portion: 1, fedAt: new Date(t0) },
        { portion: 1, fedAt: new Date(t0 + HOUR) },
      ];
      const now = t0 + 2 * HOUR;
      expect(secondsUntilRoom(rows, 2, 1, 24 * HOUR, now)).toBe(22 * 3600);
      expect(secondsUntilRoom(rows, 2, 1.5, 24 * HOUR, now)).toBe(23 * 3600);
      expect(secondsUntilRoom([], 2, 1, 24 * HOUR, now)).toBe(24 * 3600);
    });
  });

  describe('concurrency and idempotency', () => {
    it('lets one user win exactly the share when feeds race with different keys', async () => {
      const harness = await start();
      const cookie = await signedIn(harness);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => feed(harness, cookie, 0.5)),
      );
      const codes = results.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 201)).toHaveLength(4);
      expect(codes.filter((c) => c === 429)).toHaveLength(6);
      expect(await harness.database.db.select().from(schema.communityFeeds)).toHaveLength(4);
    });

    it('lets the tank take exactly its cap when many users race', async () => {
      const harness = await start();
      const cookies: string[] = [];
      for (let i = 0; i < 6; i++) cookies.push(await signedIn(harness));
      const results = await Promise.all(cookies.map((cookie) => feed(harness, cookie, 1)));
      const codes = results.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 201)).toHaveLength(COMMUNITY_TANK_FEED_CAP.portions);
      expect(codes.filter((c) => c === 429)).toHaveLength(6 - COMMUNITY_TANK_FEED_CAP.portions);
      const state = communityStateSchema.parse((await getState(harness)).json());
      expect(state.tankFeedRemaining).toBeCloseTo(0);
    });

    it('applies one feed when the same key arrives in parallel', async () => {
      const harness = await start();
      const cookie = await signedIn(harness);
      const key = randomUUID();
      const before = communityStateSchema.parse((await getState(harness)).json());
      const results = await Promise.all(
        Array.from({ length: 25 }, () => feed(harness, cookie, 1, key)),
      );
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(24);
      expect(await harness.database.db.select().from(schema.communityFeeds)).toHaveLength(1);
      const after = communityStateSchema.parse((await getState(harness)).json());
      const added = after.tank.water.uneatenFood - before.tank.water.uneatenFood;
      expect(added).toBeGreaterThan(0);
      expect(added).toBeLessThan(1.01);
    });

    it('replays a known key before the rate limit, and still limits a new one', async () => {
      const harness = await start({ community: { feed: { max: 1, windowMs: 60_000 } } });
      const cookie = await signedIn(harness);
      const key = randomUUID();
      expect((await feed(harness, cookie, 0.5, key)).statusCode).toBe(201);
      const replay = await feed(harness, cookie, 0.5, key);
      expect(replay.statusCode).toBe(200);
      expect(communityFeedResponseSchema.parse(replay.json()).replayed).toBe(true);
      const fresh = await feed(harness, cookie, 0.5);
      expect(fresh.statusCode).toBe(429);
      expect(errorCode(fresh)).toBe('rate_limited');
      expect((await feed(harness, cookie, 0.5, key)).statusCode).toBe(200);
    });

    it('replays a key even after the quota is spent', async () => {
      const harness = await start();
      const cookie = await signedIn(harness);
      const key = randomUUID();
      await feed(harness, cookie, 1, key);
      await feed(harness, cookie, 1);
      expect((await feed(harness, cookie, 1)).statusCode).toBe(429);
      expect((await feed(harness, cookie, 1, key)).statusCode).toBe(200);
    });

    it('rejects a key reused for a different feed', async () => {
      const harness = await start();
      const cookie = await signedIn(harness);
      const key = randomUUID();
      await feed(harness, cookie, 0.5, key);
      const clash = await feed(harness, cookie, 0.7, key);
      expect(clash.statusCode).toBe(409);
    });

    it('scopes a key to its user', async () => {
      const harness = await start();
      const a = await signedIn(harness);
      const b = await signedIn(harness);
      const key = randomUUID();
      expect((await feed(harness, a, 0.5, key)).statusCode).toBe(201);
      expect((await feed(harness, b, 0.5, key)).statusCode).toBe(201);
    });
  });

  describe('stream', () => {
    it('sends the proxy-safe headers and a first state frame to an anonymous viewer', async () => {
      const harness = await start();
      const base = await listen(harness);
      const s = await watch(base);
      expect(s.status).toBe(200);
      expect(s.headers.get('content-type')).toContain('text/event-stream');
      expect(s.headers.get('cache-control')).toContain('no-store');
      expect(s.headers.get('x-accel-buffering')).toBe('no');
      expect(s.headers.get('content-security-policy')).toBeTruthy();
      const state = communityStreamStateSchema.parse((await s.next('state')).data);
      expect(state.tank.fish).toHaveLength(13);
      expect(state.viewers).toBe(1);
    });

    it('pushes a feed event and fresh state to every viewer', async () => {
      const harness = await start();
      const base = await listen(harness);
      const cookie = await signedIn(harness);
      const one = await watch(base);
      const two = await watch(base, { cookie });
      await one.next('state');
      await two.next('state');
      expect((await feed(harness, cookie, 0.5)).statusCode).toBe(201);
      for (const s of [one, two]) {
        const event = communityEventSchema.parse((await s.next('feed')).data);
        expect(event).toMatchObject({ type: 'feed', food: 'flakes', portion: 0.5 });
        const updated = communityStreamStateSchema.parse((await s.next('state', 1)).data);
        expect(updated.tankFeedRemaining).toBeCloseTo(COMMUNITY_TANK_FEED_CAP.portions - 0.5);
      }
    });

    it('never puts an email address on the wire', async () => {
      const harness = await start();
      const base = await listen(harness);
      const cookie = await signedIn(harness);
      const s = await watch(base);
      await s.next('state');
      await feed(harness, cookie, 0.5);
      await s.next('feed');
      expect(JSON.stringify(s.frames)).not.toContain('@');
    });

    it('sends heartbeats and frees the slot when a viewer disconnects', async () => {
      const harness = await start({ community: { heartbeatMs: 40 } });
      const base = await listen(harness);
      const one = await watch(base);
      const two = await watch(base);
      await one.next('state');
      await two.next('state');
      await one.next('viewers');
      two.close();
      await two.closed;
      const deadline = Date.now() + 5000;
      let latest = 2;
      let seen = one.frames.length;
      while (latest !== 1 && Date.now() < deadline) {
        const beat = await one.next('viewers', seen);
        seen = one.frames.indexOf(beat) + 1;
        latest = (beat.data as { viewers: number }).viewers;
      }
      expect(latest).toBe(1);
    });

    it('announces a death found while viewers are watching', async () => {
      const harness = await start({ community: { tickMs: 40 } });
      const base = await listen(harness);
      const s = await watch(base);
      await s.next('state');
      await advance(harness, 20 * 24 * HOUR);
      const death = communityEventSchema.parse((await s.next('death')).data);
      expect(death).toMatchObject({ type: 'death', cause: 'starvation' });
      const latest = communityStreamStateSchema.parse((await s.next('state', 1)).data);
      expect(latest.tank.fish.some((f) => f.status === 'dead')).toBe(true);
    });

    it('ends open streams when the app closes', async () => {
      const harness = await start();
      const base = await listen(harness);
      const s = await watch(base);
      await s.next('state');
      h = undefined;
      const closing = harness.close();
      await Promise.race([
        s.closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('stream stayed open')), 5000)),
      ]);
      await closing;
    });

    it('limits streams per user and frees a slot on close', async () => {
      const harness = await start({
        community: { streams: { perUser: 2, perIp: 50, total: 50, maxQueue: 32, stallMs: 30_000 } },
      });
      const base = await listen(harness);
      const cookie = await signedIn(harness);
      const one = await watch(base, { cookie });
      await watch(base, { cookie });
      const third = await watch(base, { cookie });
      expect(third.status).toBe(429);
      expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await watch(base)).status).toBe(200);
      one.close();
      await one.closed;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await watch(base, { cookie })).status).toBe(200);
    });

    it('limits streams per network address', async () => {
      const harness = await start({
        community: { streams: { perUser: 5, perIp: 2, total: 50, maxQueue: 32, stallMs: 30_000 } },
      });
      const base = await listen(harness);
      await watch(base, { ip: '10.1.1.1' });
      await watch(base, { ip: '10.1.1.1' });
      expect((await watch(base, { ip: '10.1.1.1' })).status).toBe(429);
      expect((await watch(base, { ip: '10.1.1.2' })).status).toBe(200);
    });

    it('limits the total number of streams', async () => {
      const harness = await start({
        community: { streams: { perUser: 5, perIp: 50, total: 2, maxQueue: 32, stallMs: 30_000 } },
      });
      const base = await listen(harness);
      await watch(base, { ip: '10.2.2.1' });
      await watch(base, { ip: '10.2.2.2' });
      const refused = await watch(base, { ip: '10.2.2.3' });
      expect(refused.status).toBe(503);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    });

    it('throttles connection attempts per address', async () => {
      const harness = await start({ community: { connect: { max: 2, windowMs: 60_000 } } });
      const base = await listen(harness);
      expect((await watch(base)).status).toBe(200);
      expect((await watch(base)).status).toBe(200);
      expect((await watch(base)).status).toBe(429);
    });
  });

  describe('accounts', () => {
    it('includes community feeds in the export and removes them with the account', async () => {
      const harness = await start();
      const cookie = await signedIn(harness);
      await feed(harness, cookie, 0.5);
      const exported = await post(harness, cookie, '/api/me/export', {});
      expect(exported.statusCode).toBe(200);
      const data = dataExportSchema.parse(exported.json());
      expect(data.communityFeeds).toHaveLength(1);
      expect(data.communityFeeds[0]).toMatchObject({ food: 'flakes', portion: 0.5 });

      const gone = await post(harness, cookie, '/api/me/delete', { password: PASSWORD });
      expect(gone.statusCode).toBe(204);
      expect(await harness.database.db.select().from(schema.communityFeeds)).toHaveLength(0);
      const tank = communityStateSchema.parse((await getState(harness)).json()).tank;
      expect(tank.fish).toHaveLength(13);
    });
  });
});
