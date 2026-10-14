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
import { pruneExpired } from './maintenance.ts';
import { APP_ORIGIN, createHarness, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

async function account(h: Harness) {
  const email = `t20-${Date.now()}-${counter++}@bas.lu`;
  const signedUp = await h.app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: jsonHeaders,
    payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/' },
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

  it('documents exactly the cookies Better Auth can set', async () => {
    const ctx = await h.auth.$context;
    const possible = [
      ctx.authCookies.sessionToken.name,
      ctx.authCookies.dontRememberToken.name,
      ctx.createAuthCookie('better-auth-passkey').name,
    ].sort();
    const documented = privacyPolicySchema
      .parse((await h.app.inject('/api/privacy')).json())
      .cookies.map((c) => c.name)
      .sort();
    expect(documented).toEqual(possible);

    const { cookie } = await account(h);
    for (const name of cookie.split('; ').map((c) => c.split('=')[0])) {
      expect(documented).toContain(name);
    }
  });

  it('names the controller and contact, and covers the required disclosures', async () => {
    const policy = privacyPolicySchema.parse((await h.app.inject('/api/privacy')).json());
    expect(policy.controller).not.toBe('');
    expect(policy.contact).toBe('fish@bas.lu');
    const text = policy.sections.flatMap((s) => s.paragraphs).join('\n');
    for (const term of [
      'AAGUID',
      'IP address',
      'user-agent',
      'reverse proxy',
      'mail relay',
      'Backup',
    ]) {
      expect(text).toContain(term);
    }
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
    for (const e of credits.entries) {
      expect(e.referenceOnly).toBe(e.kind === 'reference-photo');
      if (e.licence === 'CC0-1.0' || e.referenceOnly) expect(e.modifications).toEqual([]);
      else expect(e.modifications.length).toBeGreaterThan(0);
    }
    expect(sa.every((e) => e.referenceOnly)).toBe(true);
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
        { ...base, id: 'c', licence: 'CC0-1.0', modifications: [] },
        { ...base, id: 'd', kind: 'reference-photo', modifications: [] },
      ],
    });
    expect(credits.entries.find((e) => e.id === 'a')?.modifications).toEqual([
      'decimated to 5k triangles',
    ]);
    expect(credits.entries.find((e) => e.id === 'b')?.modifications).toEqual([
      UNRECORDED_MODIFICATION,
    ]);
    expect(credits.entries.find((e) => e.id === 'c')?.modifications).toEqual([]);
    expect(credits.entries.find((e) => e.id === 'd')).toMatchObject({
      modifications: [],
      referenceOnly: true,
    });
  });

  describe('licence rule', () => {
    const entry = {
      id: 'x',
      kind: 'fish',
      title: 'T',
      author: 'A',
      author_url: 'https://example.com/a',
      source_url: 'https://example.com/s',
      licence: 'CC-BY-4.0',
      licence_url: 'https://creativecommons.org/licenses/by/4.0/',
      modifications: [],
      status: 'downloaded',
    };
    const photo = {
      ...entry,
      kind: 'reference-photo',
      licence: 'CC-BY-SA-4.0',
      species: 'bronze-corydoras',
      author: 'Gabriel Resende Veiga (GABS)',
    };
    const build = (a: object) => () => buildCredits({ assets: [{ ...entry, ...a }] });

    it('accepts CC0, CC-BY 3.0/4.0 and the approved CC-BY-SA reference photos', () => {
      for (const licence of ['CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0']) {
        expect(build({ licence })).not.toThrow();
      }
      expect(build(photo)).not.toThrow();
      expect(
        build({
          ...photo,
          species: 'royal-gramma',
          author: 'H. Zell (Llez)',
          licence: 'CC-BY-SA-3.0',
        }),
      ).not.toThrow();
      expect(
        build({ ...photo, species: 'banggai-cardinalfish', author: 'David J. Stang' }),
      ).not.toThrow();
    });

    it('accepts http and https URLs only', () => {
      for (const url of ['http://example.com/a', 'https://example.com/a']) {
        expect(build({ author_url: url, source_url: url, licence_url: url })).not.toThrow();
      }
      for (const field of ['author_url', 'source_url', 'licence_url']) {
        for (const url of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)']) {
          expect(build({ [field]: url })).toThrow();
        }
      }
    });

    it('rejects anything else, loudly', () => {
      for (const licence of ['CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'CC-BY-2.0', 'CC-BY-SA-4.0', 'MIT']) {
        expect(build({ licence })).toThrow(/not allowed/);
      }
      expect(build({ ...photo, kind: 'fish' })).toThrow(/not allowed/);
      expect(build({ ...photo, author: 'Someone Else' })).toThrow(/not allowed/);
      expect(build({ ...photo, species: 'neon-tetra' })).toThrow(/not allowed/);
      expect(
        build({ ...photo, status: 'selected-pending-download', licence: 'CC-BY-NC-4.0' }),
      ).toThrow(/not allowed/);
    });
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
    const res = await h.app.inject({ method: 'POST', url: '/api/me/export' });
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

    const res = await call(h, alice.cookie, 'POST', '/api/me/export', {});
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

  it('cannot be triggered cross-site or by a plain GET, and never spends quota doing so', async () => {
    const dave = await account(h);
    const get = await call(h, dave.cookie, 'GET', '/api/me/export', undefined, {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
    });
    expect(get.statusCode).toBe(404);
    const foreign = [
      await call(h, dave.cookie, 'POST', '/api/me/export', {}, { origin: 'https://evil.example' }),
      await call(
        h,
        dave.cookie,
        'POST',
        '/api/me/export',
        {},
        { origin: '', referer: 'https://evil.example/x' },
      ),
      await h.app.inject({
        method: 'POST',
        url: '/api/me/export',
        headers: { cookie: dave.cookie },
      }),
    ];
    for (const res of foreign) expect(res.statusCode).toBe(403);
    for (let i = 0; i < 5; i++) await call(h, dave.cookie, 'GET', '/api/me/export');
    expect((await call(h, dave.cookie, 'POST', '/api/me/export', {})).statusCode).toBe(200);
    expect((await call(h, dave.cookie, 'POST', '/api/me/export', {})).statusCode).toBe(200);
    expect((await call(h, dave.cookie, 'POST', '/api/me/export', {})).statusCode).toBe(429);
  });

  it('is rate limited per user', async () => {
    const carol = await account(h);
    expect((await call(h, carol.cookie, 'POST', '/api/me/export', {})).statusCode).toBe(200);
    expect((await call(h, carol.cookie, 'POST', '/api/me/export', {})).statusCode).toBe(200);
    const limited = await call(h, carol.cookie, 'POST', '/api/me/export', {});
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

  it("removes the user's passkey challenge rows and leaves other users' rows", async () => {
    const alice = await account(h);
    const bob = await account(h);
    const row = (id: string, userId: string) => ({
      id,
      identifier: `token-${id}`,
      value: JSON.stringify({
        type: 'registration',
        expectedChallenge: 'c',
        userData: { id: userId, name: 'n', displayName: 'n' },
        context: null,
      }),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await h.database.db
      .insert(schema.verification)
      .values([row('v-alice', alice.userId), row('v-bob', bob.userId)]);

    expect(
      (await call(h, alice.cookie, 'POST', '/api/me/delete', { password: PASSWORD })).statusCode,
    ).toBe(204);

    const left = (await h.database.db.select().from(schema.verification)).map((v) => v.id);
    expect(left).not.toContain('v-alice');
    expect(left).toContain('v-bob');
  });

  it("removes the user's password reset rows and leaves other users' rows", async () => {
    const alice = await account(h);
    const bob = await account(h);
    const row = (id: string, userId: string) => ({
      id,
      identifier: `reset-${id}`,
      value: userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await h.database.db
      .insert(schema.verification)
      .values([row('r-alice', alice.userId), row('r-bob', bob.userId)]);

    expect(
      (await call(h, alice.cookie, 'POST', '/api/me/delete', { password: PASSWORD })).statusCode,
    ).toBe(204);

    const left = (await h.database.db.select().from(schema.verification)).map((v) => v.id);
    expect(left).not.toContain('r-alice');
    expect(left).toContain('r-bob');
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

  it('keeps the limit when other routes with shorter windows are busy', async () => {
    const frank = await account(h);
    for (let i = 0; i < 3; i++) {
      await call(h, frank.cookie, 'POST', '/api/me/delete', { password: 'guess guess 1' });
    }
    await populate(h, frank.cookie);
    for (let i = 0; i < 25; i++) {
      await call(h, frank.cookie, 'POST', '/api/tanks', { name: 'x', biome: 'freshwater' });
    }
    const blocked = await call(h, frank.cookie, 'POST', '/api/me/delete', { password: PASSWORD });
    expect(blocked.statusCode).toBe(429);
  });
});

describe('maintenance', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('prunes expired sessions and keeps live ones', async () => {
    const gina = await account(h);
    await h.database.db.insert(schema.session).values({
      id: 'expired-session',
      token: 'expired-token',
      userId: gina.userId,
      expiresAt: new Date(Date.now() - 1000),
      updatedAt: new Date(),
    });
    const { sessions } = await pruneExpired(h.database);
    expect(sessions).toBe(1);
    expect((await counts(h, gina.userId)).sessions).toBe(1);
  });

  it('prunes mail limiter hits older than a day and keeps recent ones', async () => {
    await h.database.pool.query('delete from mail_limit_hits');
    await h.database.pool.query(
      `insert into mail_limit_hits (key, at) values
        ('old', now() - interval '25 hours'),
        ('recent', now() - interval '23 hours')`,
    );
    await pruneExpired(h.database);
    const rows = await h.database.pool.query('select key from mail_limit_hits');
    expect(rows.rows).toEqual([{ key: 'recent' }]);
  });

  it('has an index on mail_limit_hits.at for the prune', async () => {
    const rows = await h.database.pool.query(
      `select 1 from pg_indexes where tablename = 'mail_limit_hits' and indexname = 'mail_limit_hits_at_idx'`,
    );
    expect(rows.rowCount).toBe(1);
  });
});
