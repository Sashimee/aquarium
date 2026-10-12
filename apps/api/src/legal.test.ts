import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  apiErrorSchema,
  creditsSchema,
  dataExportSchema,
  privacyPolicySchema,
  tankSchema,
} from '@aquarium/shared';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCredits, loadCredits, UNRECORDED_MODIFICATION } from './credits.ts';
import { schema } from './db/index.ts';
import { APP_ORIGIN, createHarness, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

async function account(h: Harness) {
  const email = `t20-${Date.now()}-${counter++}@bas.lu`;
  await h.app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: jsonHeaders,
    payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/' },
  });
  const mail = h.outbox.findLast((m) => m.to === email);
  const link = /https?:\/\/\S+verify-email\?\S+/.exec(mail?.text ?? '')?.[0];
  if (!link) throw new Error('no verification link');
  const url = new URL(link);
  const cookie = cookieOf(await h.app.inject(url.pathname + url.search));
  if (!cookie) throw new Error('verification did not sign in');
  const [user] = await h.database.db.select().from(schema.user).where(eq(schema.user.email, email));
  if (!user) throw new Error('user missing');
  return { email, cookie, userId: user.id };
}

const call = (
  h: Harness,
  cookie: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  h.app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie, ...headers },
    ...(payload ? { payload } : {}),
  });

async function populate(h: Harness, cookie: string) {
  const created = await call(h, cookie, 'POST', '/api/tanks', {
    name: 'Home',
    biome: 'freshwater',
  });
  const tank = tankSchema.parse(created.json());
  const fish = await call(h, cookie, 'POST', `/api/tanks/${tank.id}/fish`, {
    species: 'neon-tetra',
    name: 'Blip',
  });
  expect(fish.statusCode).toBe(201);
  const care = await call(h, cookie, 'POST', `/api/tanks/${tank.id}/care`, {
    type: 'feed',
    food: 'flakes',
    portion: 1,
  });
  expect(care.statusCode).toBe(200);
  return tank;
}

async function counts(h: Harness, userId: string) {
  const { db } = h.database;
  const tankRows = await db.select().from(schema.tanks).where(eq(schema.tanks.ownerId, userId));
  let fish = 0;
  let events = 0;
  let memorials = 0;
  for (const t of tankRows) {
    fish += (await db.select().from(schema.fish).where(eq(schema.fish.tankId, t.id))).length;
    events += (await db.select().from(schema.events).where(eq(schema.events.tankId, t.id))).length;
    memorials += (await db.select().from(schema.memorials).where(eq(schema.memorials.tankId, t.id)))
      .length;
  }
  return {
    users: (await db.select().from(schema.user).where(eq(schema.user.id, userId))).length,
    sessions: (await db.select().from(schema.session).where(eq(schema.session.userId, userId)))
      .length,
    accounts: (await db.select().from(schema.account).where(eq(schema.account.userId, userId)))
      .length,
    passkeys: (await db.select().from(schema.passkey).where(eq(schema.passkey.userId, userId)))
      .length,
    tanks: tankRows.length,
    fish,
    events,
    memorials,
  };
}

describe('privacy and credits', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('serves the privacy policy publicly: essential cookies only, no analytics', async () => {
    const res = await h.app.inject('/api/privacy');
    expect(res.statusCode).toBe(200);
    const policy = privacyPolicySchema.parse(res.json());
    expect(policy.analytics).toBe(false);
    expect(policy.thirdPartyTracking).toBe(false);
    expect(policy.cookies.every((c) => c.essential)).toBe(true);
    expect(policy.cookies.map((c) => c.name)).toContain('__Secure-better-auth.session_token');
  });

  it('documents the cookie the auth layer actually sets', async () => {
    const { cookie } = await account(h);
    const names = cookie.split('; ').map((c) => c.split('=')[0]);
    const documented = privacyPolicySchema
      .parse((await h.app.inject('/api/privacy')).json())
      .cookies.map((c) => c.name);
    for (const name of names) expect(documented).toContain(name);
  });

  it('generates credits from the manifest, including the approved CC-BY-SA photos', async () => {
    const res = await h.app.inject('/api/credits');
    expect(res.statusCode).toBe(200);
    const credits = creditsSchema.parse(res.json());

    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../assets/manifest.json', import.meta.url)),
        'utf8',
      ),
    ) as { assets: { id: string; status: string; licence: string; author: string }[] };
    const shipped = manifest.assets.filter((a) => a.status === 'downloaded');
    expect(credits.entries.map((e) => e.id).sort()).toEqual(shipped.map((a) => a.id).sort());
    for (const a of shipped) {
      const entry = credits.entries.find((e) => e.id === a.id);
      expect(entry?.licence).toBe(a.licence);
      expect(entry?.author).toBe(a.author);
      expect(entry?.attribution).toContain(a.author);
      expect(entry?.attribution).toContain(a.licence);
    }

    const sa = credits.entries.filter((e) => e.shareAlike);
    expect(sa.length).toBeGreaterThanOrEqual(3);
    expect(sa.every((e) => e.licence.startsWith('CC-BY-SA'))).toBe(true);
    const bySpecies = (id: string) => sa.filter((e) => e.species === id);
    expect(bySpecies('bronze-corydoras')[0]?.author).toBe('Gabriel Resende Veiga (GABS)');
    expect(bySpecies('royal-gramma')[0]).toMatchObject({
      author: 'H. Zell (Llez)',
      licence: 'CC-BY-SA-3.0',
    });
    expect(bySpecies('banggai-cardinalfish')[0]?.author).toBe('David J. Stang');
    expect(credits.entries.filter((e) => e.licence === 'CC-BY-3.0').length).toBeGreaterThan(0);
    expect(credits.shareAlikeNotice).toMatch(/BY-SA/);
    for (const e of credits.entries) expect(e.modifications.length).toBeGreaterThan(0);
    expect(credits.entries.slice(0, sa.length).every((e) => e.shareAlike)).toBe(true);
  });

  it('refuses a manifest entry without attribution data', () => {
    expect(() =>
      buildCredits({
        assets: [{ id: 'x', kind: 'fish', title: 'T', licence: 'CC-BY-4.0', status: 'downloaded' }],
      }),
    ).toThrow();
    expect(loadCredits().entries.length).toBeGreaterThan(0);
  });

  it('shows recorded modifications, and a fallback line when none are recorded', () => {
    const base = {
      kind: 'fish',
      title: 'T',
      author: 'A',
      author_url: 'https://example.com/a',
      source_url: 'https://example.com/s',
      licence: 'CC-BY-4.0',
      licence_url: 'https://creativecommons.org/licenses/by/4.0/',
      status: 'downloaded',
    };
    const credits = buildCredits({
      assets: [
        { ...base, id: 'a', modifications: ['decimated to 5k triangles'] },
        { ...base, id: 'b', modifications: [] },
      ],
    });
    expect(credits.entries.find((e) => e.id === 'a')?.modifications).toEqual([
      'decimated to 5k triangles',
    ]);
    expect(credits.entries.find((e) => e.id === 'b')?.modifications).toEqual([
      UNRECORDED_MODIFICATION,
    ]);
  });
});

describe('data export', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({
      legalLimits: {
        export: { max: 2, windowMs: 60_000 },
        deleteAttempt: { max: 100, windowMs: 60_000 },
      },
    });
  });
  afterAll(() => h.close());

  it('requires a session', async () => {
    const res = await h.app.inject('/api/me/export');
    expect(res.statusCode).toBe(401);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('unauthenticated');
  });

  it("exports all of the caller's data and nothing secret or foreign", async () => {
    const alice = await account(h);
    const bob = await account(h);
    const tank = await populate(h, alice.cookie);
    await populate(h, bob.cookie);
    await h.database.db.insert(schema.passkey).values({
      id: 'pk-alice',
      name: 'Laptop',
      publicKey: 'SECRET-PUBLIC-KEY',
      userId: alice.userId,
      credentialID: 'SECRET-CREDENTIAL',
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
    });

    const res = await call(h, alice.cookie, 'GET', '/api/me/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toContain('attachment');
    const data = dataExportSchema.parse(res.json());

    expect(data.user.email).toBe(alice.email);
    expect(data.sessions).toHaveLength(1);
    expect(data.signInMethods[0]).toMatchObject({ providerId: 'credential', hasPassword: true });
    expect(data.passkeys).toEqual([expect.objectContaining({ id: 'pk-alice', name: 'Laptop' })]);
    expect(data.tanks).toHaveLength(1);
    const [exported] = data.tanks;
    expect(exported?.tank['id']).toBe(tank.id);
    expect(exported?.fish).toHaveLength(1);
    expect(exported?.events.length).toBeGreaterThan(0);

    const raw = res.body;
    expect(raw).not.toContain(bob.email);
    expect(raw).not.toContain('SECRET-PUBLIC-KEY');
    expect(raw).not.toContain('SECRET-CREDENTIAL');
    const [row] = await h.database.db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, alice.userId));
    expect(raw).not.toContain(row?.password ?? 'unreachable');
    expect(raw).not.toMatch(/"token"/);
  });

  it('is rate limited per user', async () => {
    const carol = await account(h);
    expect((await call(h, carol.cookie, 'GET', '/api/me/export')).statusCode).toBe(200);
    expect((await call(h, carol.cookie, 'GET', '/api/me/export')).statusCode).toBe(200);
    const limited = await call(h, carol.cookie, 'GET', '/api/me/export');
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('account deletion', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('requires a session', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/me/delete',
      headers: jsonHeaders,
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing or wrong password and deletes nothing', async () => {
    const alice = await account(h);
    await populate(h, alice.cookie);
    for (const payload of [{}, { password: 'wrong password!!' }]) {
      const res = await call(h, alice.cookie, 'POST', '/api/me/delete', payload);
      expect(res.statusCode).toBe(403);
      expect(apiErrorSchema.parse(res.json()).error.code).toBe('forbidden');
    }
    expect((await counts(h, alice.userId)).users).toBe(1);
    expect((await call(h, alice.cookie, 'GET', '/api/me')).statusCode).toBe(200);
  });

  it('rejects a cross-origin request carrying the session cookie', async () => {
    const alice = await account(h);
    const res = await call(
      h,
      alice.cookie,
      'POST',
      '/api/me/delete',
      { password: PASSWORD },
      { origin: 'https://evil.example' },
    );
    expect(res.statusCode).toBe(403);
    expect((await counts(h, alice.userId)).users).toBe(1);
  });

  it('rejects unknown body fields', async () => {
    const alice = await account(h);
    const res = await call(h, alice.cookie, 'POST', '/api/me/delete', {
      password: PASSWORD,
      userId: 'someone-else',
    });
    expect(res.statusCode).toBe(400);
  });

  it('cascades through everything keyed to the user and spares other users', async () => {
    const alice = await account(h);
    const bob = await account(h);
    await populate(h, alice.cookie);
    await populate(h, alice.cookie);
    const bobTank = await populate(h, bob.cookie);
    const [aliceTank] = await h.database.db
      .select()
      .from(schema.tanks)
      .where(eq(schema.tanks.ownerId, alice.userId));
    await h.database.db.insert(schema.memorials).values({
      tankId: aliceTank?.id ?? '',
      fishName: 'Old',
      species: 'neon-tetra',
      bornAt: new Date(),
      diedAt: new Date(),
      cause: 'old_age',
    });
    await h.database.db.insert(schema.passkey).values({
      id: 'pk-del',
      publicKey: 'k',
      userId: alice.userId,
      credentialID: 'c',
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
    });
    const before = await counts(h, alice.userId);
    expect(before).toMatchObject({ users: 1, sessions: 1, accounts: 1, passkeys: 1, tanks: 2 });
    expect(before.fish).toBe(2);
    expect(before.events).toBeGreaterThan(0);
    expect(before.memorials).toBe(1);
    const bobBefore = await counts(h, bob.userId);

    const res = await call(h, alice.cookie, 'POST', '/api/me/delete', { password: PASSWORD });
    expect(res.statusCode).toBe(204);

    const cleared = res.cookies.find((c) => c.name.endsWith('session_token'));
    expect(cleared?.value).toBe('');
    expect(cleared?.maxAge).toBe(0);
    expect(cleared?.httpOnly).toBe(true);

    expect(await counts(h, alice.userId)).toEqual({
      users: 0,
      sessions: 0,
      accounts: 0,
      passkeys: 0,
      tanks: 0,
      fish: 0,
      events: 0,
      memorials: 0,
    });
    expect(await counts(h, bob.userId)).toEqual(bobBefore);
    expect((await call(h, bob.cookie, 'GET', `/api/tanks/${bobTank.id}`)).statusCode).toBe(200);

    expect((await call(h, alice.cookie, 'GET', '/api/me')).statusCode).toBe(401);
    const signIn = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: jsonHeaders,
      payload: { email: alice.email, password: PASSWORD },
    });
    expect(signIn.statusCode).toBeGreaterThanOrEqual(400);
    expect(signIn.cookies).toHaveLength(0);
  });

  it('lets a passkey-only user delete with a fresh session, but not a stale one', async () => {
    const dave = await account(h);
    await h.database.db.delete(schema.account).where(eq(schema.account.userId, dave.userId));
    await h.database.db
      .update(schema.session)
      .set({ createdAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.session.userId, dave.userId));

    const stale = await call(h, dave.cookie, 'POST', '/api/me/delete', {});
    expect(stale.statusCode).toBe(403);
    expect((await counts(h, dave.userId)).users).toBe(1);

    await h.database.db
      .update(schema.session)
      .set({ createdAt: new Date() })
      .where(eq(schema.session.userId, dave.userId));
    const fresh = await call(h, dave.cookie, 'POST', '/api/me/delete', {});
    expect(fresh.statusCode).toBe(204);
    expect((await counts(h, dave.userId)).users).toBe(0);
  });
});

describe('account deletion rate limit', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({
      legalLimits: {
        export: { max: 100, windowMs: 60_000 },
        deleteAttempt: { max: 3, windowMs: 60_000 },
      },
    });
  });
  afterAll(() => h.close());

  it('throttles password guessing, even with a valid session', async () => {
    const eve = await account(h);
    for (let i = 0; i < 3; i++) {
      const res = await call(h, eve.cookie, 'POST', '/api/me/delete', {
        password: 'guess guess 1',
      });
      expect(res.statusCode).toBe(403);
    }
    const blocked = await call(h, eve.cookie, 'POST', '/api/me/delete', { password: PASSWORD });
    expect(blocked.statusCode).toBe(429);
    expect((await counts(h, eve.userId)).users).toBe(1);
  });
});
