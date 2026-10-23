import {
  apiErrorSchema,
  dataExportSchema,
  galleryResponseSchema,
  galleryWeekEnd,
  galleryWeekStart,
  galleryWinnersResponseSchema,
  publicTankSchema,
  tankSchema,
  voteStateSchema,
} from '@aquarium/shared';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from './db/index.ts';
import { settleWeeks } from './gallery.ts';
import { pruneExpired } from './maintenance.ts';
import { APP_ORIGIN, createHarness, fishPayload, topUp, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
const MINUTE_MS = 60_000;
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

async function account(h: Harness, verified = true) {
  const email = `t62-${Date.now()}-${counter++}@bas.lu`;
  await h.app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: jsonHeaders,
    payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/verify-email' },
  });
  const [user] = await h.database.db.select().from(schema.user).where(eq(schema.user.email, email));
  if (!user) throw new Error('user missing');
  const link = /https?:\/\/\S+verify-email\?\S+/.exec(
    h.outbox.findLast((m) => m.to === email)?.text ?? '',
  )?.[0];
  if (!link) throw new Error('no verification link');
  const url = new URL(link);
  const cookie = cookieOf(await h.app.inject(url.pathname + url.search));
  if (!verified) {
    await h.database.db
      .update(schema.user)
      .set({ emailVerified: false })
      .where(eq(schema.user.id, user.id));
  }
  return { cookie, userId: user.id };
}

type Account = Awaited<ReturnType<typeof account>>;

async function call(
  h: Harness,
  cookie: string | null,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) {
  let body = payload;
  if (method === 'POST' && /^\/api\/tanks(\/[^/]+\/fish)?$/.test(url)) {
    await topUp(h, 50_000);
    if (url === '/api/tanks') body = { idempotencyKey: randomUUID(), ...body };
  }
  return h.app.inject({
    method,
    url,
    headers: { ...jsonHeaders, ...(cookie ? { cookie } : {}) },
    ...(body ? { payload: body } : {}),
  });
}

async function newTank(h: Harness, owner: Account, name: string, shared = true, listed = true) {
  const tank = tankSchema.parse(
    (await call(h, owner.cookie, 'POST', '/api/tanks', { name, biome: 'freshwater' })).json(),
  );
  await call(
    h,
    owner.cookie,
    'POST',
    `/api/tanks/${tank.id}/fish`,
    fishPayload('neon-tetra', 'Blip'),
  );
  if (shared) {
    await call(h, owner.cookie, 'POST', `/api/tanks/${tank.id}/share`);
    if (listed)
      await call(h, owner.cookie, 'PUT', `/api/tanks/${tank.id}/gallery`, { listed: true });
  }
  return tank.id;
}

const vote = (h: Harness, voter: Account | null, tankId: string) =>
  call(h, voter?.cookie ?? null, 'PUT', '/api/gallery/vote', { tankId });

const gallery = async (h: Harness, viewer: Account | null = null, query = '') =>
  galleryResponseSchema.parse(
    (await call(h, viewer?.cookie ?? null, 'GET', `/api/gallery${query}`)).json(),
  );

const winners = async (h: Harness) =>
  galleryWinnersResponseSchema.parse((await call(h, null, 'GET', '/api/gallery/winners')).json())
    .winners;

const advanceTo = (h: Harness, targetMs: number) =>
  h.app.inject({
    method: 'POST',
    url: '/api/test/advance-time',
    headers: jsonHeaders,
    payload: { minutes: Math.ceil((targetMs - h.clock.now()) / MINUTE_MS) },
  });

const nextWeek = (h: Harness) =>
  advanceTo(h, Date.parse(galleryWeekEnd(galleryWeekStart(h.clock.now()))) + MINUTE_MS);

describe('week boundaries', () => {
  it('starts on Monday 00:00 UTC and is half-open', () => {
    const monday = Date.parse('2026-10-19T00:00:00.000Z');
    expect(galleryWeekStart(monday)).toBe('2026-10-19T00:00:00.000Z');
    expect(galleryWeekStart(monday - 1)).toBe('2026-10-12T00:00:00.000Z');
    expect(galleryWeekStart(Date.parse('2026-10-25T23:59:59.999Z'))).toBe(
      '2026-10-19T00:00:00.000Z',
    );
    expect(galleryWeekEnd('2026-10-19T00:00:00.000Z')).toBe('2026-10-26T00:00:00.000Z');
    expect(galleryWeekStart(0)).toBe('1969-12-29T00:00:00.000Z');
  });
});

describe('gallery listing', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('lists only shared tanks, publicly, without owner identity', async () => {
    const owner = await account(h);
    const open = await newTank(h, owner, 'Open water');
    const hidden = await newTank(h, owner, 'Hidden', false);

    const res = await call(h, null, 'GET', '/api/gallery');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    const ids = galleryResponseSchema.parse(res.json()).entries.map((e) => e.id);
    expect(ids).toContain(open);
    expect(ids).not.toContain(hidden);
    expect(res.body).not.toContain(owner.userId);
    expect((await call(h, null, 'GET', `/api/gallery/${hidden}`)).statusCode).toBe(404);
  });

  it('serves a public snapshot for a listed tank', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Snapshot me');
    const res = await call(h, null, 'GET', `/api/gallery/${id}`);
    expect(res.statusCode).toBe(200);
    expect(publicTankSchema.parse(res.json()).name).toBe('Snapshot me');
    expect((await call(h, null, 'GET', `/api/gallery/${randomUUID()}`)).statusCode).toBe(404);
    expect((await call(h, null, 'GET', '/api/gallery/not-a-uuid')).statusCode).toBe(400);
  });

  it('drops a tank the moment its link is revoked and does not relist it when shared again', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Comes and goes');
    expect((await gallery(h)).entries.map((e) => e.id)).toContain(id);

    await call(h, owner.cookie, 'DELETE', `/api/tanks/${id}/share`);
    expect((await gallery(h)).entries.map((e) => e.id)).not.toContain(id);
    expect((await call(h, null, 'GET', `/api/gallery/${id}`)).statusCode).toBe(404);
    const voter = await account(h);
    expect((await vote(h, voter, id)).statusCode).toBe(404);

    await call(h, owner.cookie, 'POST', `/api/tanks/${id}/share`);
    expect((await gallery(h)).entries.map((e) => e.id)).not.toContain(id);
  });

  it('pages deterministically', async () => {
    const owner = await account(h);
    await newTank(h, owner, 'Page one');
    await newTank(h, owner, 'Page two');
    const all = await gallery(h);
    const first = await gallery(h, null, '?limit=1&offset=0');
    const second = await gallery(h, null, '?limit=1&offset=1');
    expect(first.total).toBe(all.total);
    expect(first.entries.map((e) => e.id)).toEqual([all.entries[0]?.id]);
    expect(second.entries.map((e) => e.id)).toEqual([all.entries[1]?.id]);
    expect((await call(h, null, 'GET', '/api/gallery?limit=500')).statusCode).toBe(400);
    expect((await call(h, null, 'GET', '/api/gallery?bogus=1')).statusCode).toBe(400);
  });

  it('marks the viewer own tanks', async () => {
    const owner = await account(h);
    const other = await account(h);
    const id = await newTank(h, owner, 'Mine');
    expect((await gallery(h, owner)).entries.find((e) => e.id === id)?.mine).toBe(true);
    expect((await gallery(h, other)).entries.find((e) => e.id === id)?.mine).toBe(false);
    expect((await gallery(h)).entries.find((e) => e.id === id)?.mine).toBe(false);
  });
});

describe('gallery opt-in', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const setListed = (owner: Account | null, id: string, listed: boolean) =>
    call(h, owner?.cookie ?? null, 'PUT', `/api/tanks/${id}/gallery`, { listed });

  it('does not list a tank just because it has a public link', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Friends only', true, false);
    const created = tankSchema.parse(
      (await call(h, owner.cookie, 'GET', `/api/tanks/${id}`)).json(),
    );
    expect(created).toMatchObject({ shared: true, inGallery: false });
    expect((await gallery(h)).entries.map((e) => e.id)).not.toContain(id);
    expect((await call(h, null, 'GET', `/api/gallery/${id}`)).statusCode).toBe(404);
    expect((await vote(h, await account(h), id)).statusCode).toBe(404);
  });

  it('lists on request, and unlisting keeps the link', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Opt in', true, false);
    const on = tankSchema.parse((await setListed(owner, id, true)).json());
    expect(on.inGallery).toBe(true);
    expect((await gallery(h)).entries.map((e) => e.id)).toContain(id);
    const off = tankSchema.parse((await setListed(owner, id, false)).json());
    expect(off).toMatchObject({ inGallery: false, shared: true });
    expect((await gallery(h)).entries.map((e) => e.id)).not.toContain(id);
  });

  it('needs the link, and revoking the link clears the listing for good', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Linkless', false);
    expect((await setListed(owner, id, true)).statusCode).toBe(409);

    await call(h, owner.cookie, 'POST', `/api/tanks/${id}/share`);
    await setListed(owner, id, true);
    await call(h, owner.cookie, 'DELETE', `/api/tanks/${id}/share`);
    await call(h, owner.cookie, 'POST', `/api/tanks/${id}/share`);
    const again = tankSchema.parse((await call(h, owner.cookie, 'GET', `/api/tanks/${id}`)).json());
    expect(again.inGallery).toBe(false);
    expect((await gallery(h)).entries.map((e) => e.id)).not.toContain(id);
  });

  it('refuses to list a quarantine tank', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Sick bay', true, false);
    await h.database.db
      .update(schema.tanks)
      .set({ quarantine: true })
      .where(eq(schema.tanks.id, id));
    expect((await setListed(owner, id, true)).statusCode).toBe(409);
    expect((await gallery(h)).entries.map((e) => e.id)).not.toContain(id);
  });

  it('audits only real listing changes', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Flip flop', true, false);
    for (const listed of [true, true, false, false, true]) {
      expect((await setListed(owner, id, listed)).statusCode).toBe(200);
    }
    const rows = await h.database.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tankId, id), eq(schema.auditLog.actorId, owner.userId)))
      .orderBy(schema.auditLog.id);
    expect(rows.filter((r) => r.action.startsWith('gallery_')).map((r) => r.action)).toEqual([
      'gallery_listed',
      'gallery_unlisted',
      'gallery_listed',
    ]);
  });

  it('is owner only and needs a session', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Not yours', true, false);
    expect((await setListed(null, id, true)).statusCode).toBe(401);
    expect((await setListed(await account(h), id, true)).statusCode).toBe(404);
    expect(
      (await call(h, owner.cookie, 'PUT', `/api/tanks/${id}/gallery`, { listed: 'yes' }))
        .statusCode,
    ).toBe(400);
    expect((await gallery(h)).entries.map((e) => e.id)).not.toContain(id);
  });

  it('puts the flag in the account export', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Exported flag');
    const data = dataExportSchema.parse(
      (await call(h, owner.cookie, 'POST', '/api/me/export', {})).json(),
    );
    expect(data.tanks.find((t) => t.tank['id'] === id)?.tank['inGallery']).toBe(true);
  });

  it('reports no vote for a tank that left the gallery', async () => {
    const owner = await account(h);
    const voter = await account(h);
    const id = await newTank(h, owner, 'Left after vote');
    await vote(h, voter, id);
    await setListed(owner, id, false);
    expect((await gallery(h, voter)).myVote).toBeNull();
  });
});

describe('voting', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('requires a signed-in, verified account', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Needs auth');
    const anon = await vote(h, null, id);
    expect(anon.statusCode).toBe(401);
    expect(apiErrorSchema.parse(anon.json()).error.code).toBe('unauthenticated');
    const unverified = await vote(h, await account(h, false), id);
    expect(unverified.statusCode).toBe(403);
    expect(apiErrorSchema.parse(unverified.json()).error.code).toBe('email_not_verified');
    expect((await call(h, null, 'DELETE', '/api/gallery/vote')).statusCode).toBe(401);
  });

  it('refuses a vote for your own tank', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Own goal');
    const res = await vote(h, owner, id);
    expect(res.statusCode).toBe(403);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('own_tank');
    expect((await gallery(h, owner)).myVote).toBeNull();
  });

  it('refuses private, unknown and malformed targets', async () => {
    const owner = await account(h);
    const voter = await account(h);
    const priv = await newTank(h, owner, 'Private', false);
    expect((await vote(h, voter, priv)).statusCode).toBe(404);
    expect((await vote(h, voter, randomUUID())).statusCode).toBe(404);
    expect((await vote(h, voter, 'nope')).statusCode).toBe(400);
  });

  it('counts one vote per account per week and lets it move or be withdrawn', async () => {
    const owner = await account(h);
    const voter = await account(h);
    const a = await newTank(h, owner, 'Candidate A');
    const b = await newTank(h, owner, 'Candidate B');

    const first = await vote(h, voter, a);
    expect(first.statusCode).toBe(200);
    expect(voteStateSchema.parse(first.json()).myVote).toBe(a);
    await vote(h, voter, a);
    await vote(h, voter, a);
    let view = await gallery(h, voter);
    expect(view.myVote).toBe(a);
    expect(view.entries.find((e) => e.id === a)).toMatchObject({ votes: 1, voted: true });

    await vote(h, voter, b);
    view = await gallery(h, voter);
    expect(view.myVote).toBe(b);
    expect(view.entries.find((e) => e.id === a)).toMatchObject({ votes: 0, voted: false });
    expect(view.entries.find((e) => e.id === b)).toMatchObject({ votes: 1, voted: true });
    const rows = await h.database.db
      .select()
      .from(schema.tankVotes)
      .where(eq(schema.tankVotes.userId, voter.userId));
    expect(rows).toHaveLength(1);

    const removed = await call(h, voter.cookie, 'DELETE', '/api/gallery/vote');
    expect(voteStateSchema.parse(removed.json()).myVote).toBeNull();
    expect((await call(h, voter.cookie, 'DELETE', '/api/gallery/vote')).statusCode).toBe(200);
    expect((await gallery(h, voter)).entries.find((e) => e.id === b)?.votes).toBe(0);
  });

  it('orders by votes and audits changes without personal data', async () => {
    const owner = await account(h);
    const [v1, v2, v3] = [await account(h), await account(h), await account(h)];
    const low = await newTank(h, owner, 'Low');
    const high = await newTank(h, owner, 'High');
    await vote(h, v1, low);
    await vote(h, v2, high);
    await vote(h, v3, high);
    const view = await gallery(h);
    expect(view.entries[0]).toMatchObject({ id: high, votes: 2 });
    const audits = await h.database.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actorId, v2.userId));
    expect(audits.map((a) => a.action)).toEqual(['vote_set']);
    expect(JSON.stringify(audits[0]?.detail)).not.toMatch(/@/);
  });

  it('removes a vote with the voter account and with the tank', async () => {
    const owner = await account(h);
    const voter = await account(h);
    const id = await newTank(h, owner, 'Short lived');
    await vote(h, voter, id);
    await h.database.db.delete(schema.tanks).where(eq(schema.tanks.id, id));
    const rows = await h.database.db
      .select()
      .from(schema.tankVotes)
      .where(eq(schema.tankVotes.userId, voter.userId));
    expect(rows).toHaveLength(0);
  });

  it('prunes votes older than 90 days and keeps newer ones', async () => {
    const owner = await account(h);
    const old = await account(h);
    const recent = await account(h);
    const id = await newTank(h, owner, 'Prune me');
    const day = 86_400_000;
    const weekAgo = (days: number) => new Date(Date.now() - days * day);
    await h.database.db.insert(schema.tankVotes).values([
      { userId: old.userId, tankId: id, weekStart: weekAgo(91) },
      { userId: recent.userId, tankId: id, weekStart: weekAgo(89) },
    ]);
    await pruneExpired(h.database, h.clock);
    const left = await h.database.db
      .select({ userId: schema.tankVotes.userId })
      .from(schema.tankVotes)
      .where(eq(schema.tankVotes.tankId, id));
    expect(left).toEqual([{ userId: recent.userId }]);
  });

  it('includes votes in the account export, hiding private tank names', async () => {
    const owner = await account(h);
    const voter = await account(h);
    const id = await newTank(h, owner, 'Exported');
    await vote(h, voter, id);
    const data = dataExportSchema.parse(
      (await call(h, voter.cookie, 'POST', '/api/me/export', {})).json(),
    );
    expect(data.galleryVotes).toHaveLength(1);
    expect(data.galleryVotes[0]?.['tank']).toBe('Exported');
    await call(h, owner.cookie, 'DELETE', `/api/tanks/${id}/share`);
    const after = dataExportSchema.parse(
      (await call(h, voter.cookie, 'POST', '/api/me/export', {})).json(),
    );
    expect(after.galleryVotes[0]?.['tank']).toBeNull();
  });
});

describe('weekly winner', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('has no winner before any week has finished', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Early');
    await vote(h, await account(h), id);
    expect(await winners(h)).toEqual([]);
  });

  it('starts a fresh count each week and names the winner of the finished one', async () => {
    const owner = await account(h);
    const voter = await account(h);
    const other = await account(h);
    const popular = await newTank(h, owner, 'Popular');
    const quiet = await newTank(h, owner, 'Quiet');
    const lastWeek = galleryWeekStart(h.clock.now());
    expect(
      (await call(h, owner.cookie, 'PATCH', `/api/tanks/${popular}`, { roomId: 'room-bedroom' }))
        .statusCode,
    ).toBe(200);
    await vote(h, voter, popular);
    await vote(h, other, popular);
    await vote(h, await account(h), quiet);

    await nextWeek(h);
    const thisWeek = galleryWeekStart(h.clock.now());
    expect(thisWeek).not.toBe(lastWeek);
    const fresh = await gallery(h, voter);
    expect(fresh.weekStart).toBe(thisWeek);
    expect(fresh.myVote).toBeNull();
    expect(fresh.entries.every((e) => e.votes === 0)).toBe(true);

    const [winner] = await winners(h);
    expect(winner).toMatchObject({ id: popular, votes: 2, weekStart: lastWeek });
    expect(winner?.weekEnd).toBe(thisWeek);
    expect(winner?.roomId).toBe('room-bedroom');

    expect((await vote(h, voter, quiet)).statusCode).toBe(200);
    expect((await gallery(h, voter)).myVote).toBe(quiet);
  });

  it('keeps a settled winner when later votes land in the new week', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Settled');
    const week = galleryWeekStart(h.clock.now());
    await vote(h, await account(h), id);
    await nextWeek(h);
    await winners(h);
    const [before] = (await winners(h)).filter((w) => w.weekStart === week);
    await vote(h, await account(h), id);
    const [after] = (await winners(h)).filter((w) => w.weekStart === week);
    expect(after).toEqual(before);
  });
});

describe('winner tie-breaks and opt-out', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('gives a tie to the tank that reached its count first', async () => {
    const owner = await account(h);
    const slow = await newTank(h, owner, 'Slow');
    const quick = await newTank(h, owner, 'Quick');
    const [a, b] = [await account(h), await account(h)];
    await vote(h, a, quick);
    await advanceTo(h, h.clock.now() + 5 * MINUTE_MS);
    await vote(h, b, slow);

    const week = galleryWeekStart(h.clock.now());
    const view = await gallery(h);
    const order = view.entries.filter((e) => e.votes === 1).map((e) => e.id);
    expect(order.indexOf(quick)).toBeLessThan(order.indexOf(slow));

    await nextWeek(h);
    const won = (await winners(h)).find((w) => w.weekStart === week);
    expect(won).toMatchObject({ id: quick, votes: 1 });
  });

  it('falls back to the lower tank id when votes arrive at the same instant', async () => {
    const owner = await account(h);
    const x = await newTank(h, owner, 'Twin X');
    const y = await newTank(h, owner, 'Twin Y');
    const [lo, hi] = [x, y].toSorted();
    if (!lo || !hi) throw new Error('tanks missing');
    await nextWeek(h);
    const week = galleryWeekStart(h.clock.now());
    const at = new Date(h.clock.now());
    for (const [tankId, voter] of [
      [hi, await account(h)],
      [lo, await account(h)],
    ] as const) {
      await h.database.db
        .insert(schema.tankVotes)
        .values({ userId: voter.userId, weekStart: new Date(week), tankId, createdAt: at });
    }
    await nextWeek(h);
    const won = (await winners(h)).find((w) => w.weekStart === week);
    expect(won?.id).toBe(lo);
  });

  it('never crowns a tank that went private before the week was settled', async () => {
    const owner = await account(h);
    const left = await newTank(h, owner, 'Opts out');
    const stays = await newTank(h, owner, 'Stays');
    const week = galleryWeekStart(h.clock.now());
    await vote(h, await account(h), left);
    await vote(h, await account(h), left);
    await vote(h, await account(h), stays);
    await call(h, owner.cookie, 'PUT', `/api/tanks/${left}/gallery`, { listed: false });

    await nextWeek(h);
    expect((await winners(h)).find((w) => w.weekStart === week)).toMatchObject({
      id: stays,
      votes: 1,
    });
  });

  it('hides a settled winner that later goes private', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Winner then private');
    const week = galleryWeekStart(h.clock.now());
    await vote(h, await account(h), id);
    await nextWeek(h);
    expect((await winners(h)).some((w) => w.weekStart === week)).toBe(true);
    await call(h, owner.cookie, 'PUT', `/api/tanks/${id}/gallery`, { listed: false });
    expect((await winners(h)).some((w) => w.weekStart === week)).toBe(false);
  });

  it('records a week with no eligible tank as no-winner so it is never re-decided', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Gone before settle');
    const week = galleryWeekStart(h.clock.now());
    await vote(h, await account(h), id);
    await call(h, owner.cookie, 'PUT', `/api/tanks/${id}/gallery`, { listed: false });
    await nextWeek(h);
    expect((await winners(h)).some((w) => w.weekStart === week)).toBe(false);
    const [row] = await h.database.db
      .select()
      .from(schema.tankOfWeek)
      .where(eq(schema.tankOfWeek.weekStart, new Date(week)));
    expect(row).toMatchObject({ tankId: null, votes: 0 });

    await call(h, owner.cookie, 'PUT', `/api/tanks/${id}/gallery`, { listed: true });
    expect((await winners(h)).some((w) => w.weekStart === week)).toBe(false);
  });

  it('files a vote cast after the rollover under the new week', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Late vote');
    const voter = await account(h);
    await nextWeek(h);
    const res = voteStateSchema.parse((await vote(h, voter, id)).json());
    expect(res.weekStart).toBe(galleryWeekStart(h.clock.now()));
    const [row] = await h.database.db
      .select()
      .from(schema.tankVotes)
      .where(eq(schema.tankVotes.userId, voter.userId));
    expect(row?.weekStart.toISOString()).toBe(res.weekStart);
  });

  it('settles each week once, however often it runs', async () => {
    const owner = await account(h);
    const id = await newTank(h, owner, 'Once');
    await vote(h, await account(h), id);
    const week = galleryWeekStart(h.clock.now());
    await nextWeek(h);
    const first = await settleWeeks(h.database, h.clock.now());
    const again = await settleWeeks(h.database, h.clock.now());
    expect(first).toBeGreaterThanOrEqual(1);
    expect(again).toBe(0);
    const rows = await h.database.db.select().from(schema.tankOfWeek);
    expect(rows.filter((r) => r.weekStart.toISOString() === week)).toHaveLength(1);
  });
});

describe('rate limits', () => {
  it('throttles votes per account and views per address', async () => {
    const h = await createHarness({
      galleryLimits: {
        view: { max: 3, windowMs: 60_000 },
        vote: { max: 2, windowMs: 60_000 },
        voteIp: { max: 100, windowMs: 60_000 },
      },
    });
    try {
      const owner = await account(h);
      const voter = await account(h);
      const id = await newTank(h, owner, 'Busy');
      expect((await vote(h, voter, id)).statusCode).toBe(200);
      expect((await vote(h, voter, id)).statusCode).toBe(200);
      const blocked = await vote(h, voter, id);
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

      for (let i = 0; i < 3; i++) {
        expect((await call(h, null, 'GET', '/api/gallery')).statusCode).toBe(200);
      }
      expect((await call(h, null, 'GET', '/api/gallery')).statusCode).toBe(429);
    } finally {
      await h.close();
    }
  });
});
