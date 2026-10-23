import {
  apiErrorSchema,
  dataExportSchema,
  PUBLIC_NAME_FALLBACK,
  publicTankSchema,
  reactionStateSchema,
  tankSchema,
} from '@aquarium/shared';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tankMaxFishLengthM } from './fishFit.ts';
import { schema } from './db/index.ts';
import { pruneExpired } from './maintenance.ts';
import { hashShareToken } from './shareToken.ts';
import { APP_ORIGIN, createHarness, fishPayload, topUp, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

async function account(h: Harness, verified = true) {
  const email = `t61-${Date.now()}-${counter++}@bas.lu`;
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
  return { cookie, userId: user.id, email };
}

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

async function sharedTank(h: Harness, cookie: string, name = 'Reef corner') {
  const created = await call(h, cookie, 'POST', '/api/tanks', { name, biome: 'freshwater' });
  const tank = tankSchema.parse(created.json());
  await call(h, cookie, 'POST', `/api/tanks/${tank.id}/fish`, fishPayload('neon-tetra', 'Blip'));
  const shared = tankSchema.parse(
    (await call(h, cookie, 'POST', `/api/tanks/${tank.id}/share`)).json(),
  );
  if (!shared.shareToken) throw new Error('no share token');
  return { id: tank.id, token: shared.shareToken };
}

describe('public tank links', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('is private by default and opens only while shared', async () => {
    const owner = await account(h);
    const created = await call(h, owner.cookie, 'POST', '/api/tanks', {
      name: 'Home',
      biome: 'freshwater',
    });
    const tank = tankSchema.parse(created.json());
    expect(tank.shareToken).toBeNull();

    const { token } = await sharedTank(h, owner.cookie);
    const open = await call(h, null, 'GET', `/api/public/${token}`);
    expect(open.statusCode).toBe(200);
    publicTankSchema.parse(open.json());

    await call(h, owner.cookie, 'DELETE', `/api/tanks/${tank.id}/share`);
    const mine = await sharedTank(h, owner.cookie);
    await call(h, owner.cookie, 'DELETE', `/api/tanks/${mine.id}/share`);
    const closed = await call(h, null, 'GET', `/api/public/${mine.token}`);
    expect(closed.statusCode).toBe(404);
    expect(apiErrorSchema.parse(closed.json()).error.code).toBe('not_found');
  });

  it('tells an emptied decor layout from a never-edited one', async () => {
    const owner = await account(h);
    const { id, token } = await sharedTank(h, owner.cookie);
    const view = async () =>
      publicTankSchema.parse((await call(h, null, 'GET', `/api/public/${token}`)).json());
    const untouched = await view();
    expect(untouched.decorEdited).toBe(false);
    expect(untouched.decorLayout).toEqual([]);

    await call(h, owner.cookie, 'PATCH', `/api/tanks/${id}`, { decorLayout: [] });
    const emptied = await view();
    expect(emptied.decorEdited).toBe(true);
    expect(emptied.decorLayout).toEqual([]);
  });

  it('serves a fish no longer than its tank holds, even if the row is', async () => {
    const owner = await account(h);
    const { id, token } = await sharedTank(h, owner.cookie);
    await h.database.db.update(schema.fish).set({ size: 0.9 }).where(eq(schema.fish.tankId, id));
    const view = publicTankSchema.parse(
      (await call(h, null, 'GET', `/api/public/${token}`)).json(),
    );
    expect(view.fish[0]?.size).toBe(tankMaxFishLengthM('standard'));
  });

  it('answers 404 for unknown and malformed tokens alike', async () => {
    const unknown = await call(h, null, 'GET', `/api/public/${'A'.repeat(43)}`);
    const malformed = await call(h, null, 'GET', '/api/public/short');
    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json()).toEqual(unknown.json());
  });

  it('stops serving the old token after a rotation', async () => {
    const owner = await account(h);
    const { id, token } = await sharedTank(h, owner.cookie);
    const rotated = tankSchema.parse(
      (await call(h, owner.cookie, 'POST', `/api/tanks/${id}/share/rotate`)).json(),
    );
    expect((await call(h, null, 'GET', `/api/public/${token}`)).statusCode).toBe(404);
    expect((await call(h, null, 'GET', `/api/public/${rotated.shareToken}`)).statusCode).toBe(200);
  });

  it('refuses to rotate a private tank, so rotation cannot publish it', async () => {
    const owner = await account(h);
    const tank = tankSchema.parse(
      (
        await call(h, owner.cookie, 'POST', '/api/tanks', { name: 'Home', biome: 'freshwater' })
      ).json(),
    );
    const res = await call(h, owner.cookie, 'POST', `/api/tanks/${tank.id}/share/rotate`);
    expect(res.statusCode).toBe(409);
    const [row] = await h.database.db
      .select()
      .from(schema.tanks)
      .where(eq(schema.tanks.id, tank.id));
    expect(row?.shareTokenHash).toBeNull();
  });

  it('sends noindex, no-store and no-referrer headers, even on a miss', async () => {
    const owner = await account(h);
    const { token } = await sharedTank(h, owner.cookie);
    for (const url of [`/api/public/${token}`, `/api/public/${'B'.repeat(43)}`]) {
      const res = await call(h, null, 'GET', url);
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
  });

  it('sends the headers on percent-encoded paths too', async () => {
    const owner = await account(h);
    const { token } = await sharedTank(h, owner.cookie);
    for (const url of [
      `/api/%70ublic/${token}`,
      `/api/public%2F${token}`,
      `/API/Public/${token}`,
    ]) {
      const res = await h.app.inject(url);
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
  });

  it('stores only a hash of the token and rounds the snapshot time to the hour', async () => {
    const owner = await account(h);
    const { id, token } = await sharedTank(h, owner.cookie);
    const [row] = await h.database.db.select().from(schema.tanks).where(eq(schema.tanks.id, id));
    expect(row?.shareTokenHash).toBe(hashShareToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const read = tankSchema.parse((await call(h, owner.cookie, 'GET', `/api/tanks/${id}`)).json());
    expect(read).toMatchObject({ shared: true, shareToken: null });
    const body = publicTankSchema.parse((await h.app.inject(`/api/public/${token}`)).json());
    const at = new Date(body.snapshotAt);
    expect([at.getUTCMinutes(), at.getUTCSeconds(), at.getUTCMilliseconds()]).toEqual([0, 0, 0]);
    expect(at.getTime()).toBeLessThanOrEqual((row?.lastTickAt ?? new Date(0)).getTime());
  });

  it('exposes no owner identity, ids or email', async () => {
    const owner = await account(h);
    await call(h, owner.cookie, 'PUT', '/api/me/handle', { handle: `own${counter}xyz` });
    const { id, token } = await sharedTank(h, owner.cookie);
    const res = await call(h, null, 'GET', `/api/public/${token}`);
    const text = res.body;
    expect(text).not.toContain(owner.userId);
    expect(text).not.toContain(owner.email);
    expect(text).not.toContain(id);
    expect(text).not.toContain(token);
    expect(text).not.toContain(`own${counter}xyz`);
    const [fish] = await h.database.db.select().from(schema.fish).where(eq(schema.fish.tankId, id));
    expect(text).not.toContain(fish?.id ?? 'missing');
    const body = publicTankSchema.parse(res.json());
    expect(body.fish).toHaveLength(1);
    expect(body.fish[0]?.name).toBe('Blip');
  });

  it('gives the same seeds on every read', async () => {
    const owner = await account(h);
    const { token } = await sharedTank(h, owner.cookie);
    const a = publicTankSchema.parse((await call(h, null, 'GET', `/api/public/${token}`)).json());
    const b = publicTankSchema.parse((await call(h, null, 'GET', `/api/public/${token}`)).json());
    expect(b.seed).toBe(a.seed);
    expect(b.fish[0]?.seed).toBe(a.fish[0]?.seed);
  });

  describe('word filter', () => {
    it('refuses to share a tank whose name is blocked, then allows it once renamed', async () => {
      const owner = await account(h);
      const tank = tankSchema.parse(
        (
          await call(h, owner.cookie, 'POST', '/api/tanks', {
            name: 'fuck tank',
            biome: 'freshwater',
          })
        ).json(),
      );
      const refused = await call(h, owner.cookie, 'POST', `/api/tanks/${tank.id}/share`);
      expect(refused.statusCode).toBe(400);
      expect(apiErrorSchema.parse(refused.json()).error.code).toBe('validation_failed');
      await call(h, owner.cookie, 'PATCH', `/api/tanks/${tank.id}`, { name: 'Calm tank' });
      expect((await call(h, owner.cookie, 'POST', `/api/tanks/${tank.id}/share`)).statusCode).toBe(
        200,
      );
    });

    it('refuses a blocked rename while shared, but allows it while private', async () => {
      const owner = await account(h);
      const { id } = await sharedTank(h, owner.cookie);
      const refused = await call(h, owner.cookie, 'PATCH', `/api/tanks/${id}`, {
        name: 'big dick tank',
      });
      expect(refused.statusCode).toBe(400);
      await call(h, owner.cookie, 'DELETE', `/api/tanks/${id}/share`);
      const allowed = await call(h, owner.cookie, 'PATCH', `/api/tanks/${id}`, {
        name: 'big dick tank',
      });
      expect(allowed.statusCode).toBe(200);
    });

    it('masks names the filter has since learned to block', async () => {
      const owner = await account(h);
      const { id, token } = await sharedTank(h, owner.cookie);
      await h.database.db
        .update(schema.tanks)
        .set({ name: 'shit show' })
        .where(eq(schema.tanks.id, id));
      await h.database.db
        .update(schema.fish)
        .set({ name: 'Fuckface' })
        .where(eq(schema.fish.tankId, id));
      const body = publicTankSchema.parse(
        (await call(h, null, 'GET', `/api/public/${token}`)).json(),
      );
      expect(body.name).toBe(PUBLIC_NAME_FALLBACK);
      expect(body.fish[0]?.name).toBe('neon-tetra');
    });
  });

  describe('reactions', () => {
    it('needs a signed-in, verified user', async () => {
      const owner = await account(h);
      const { token } = await sharedTank(h, owner.cookie);
      const url = `/api/public/${token}/reaction`;
      expect((await call(h, null, 'PUT', url, { kind: 'heart' })).statusCode).toBe(401);
      expect((await call(h, null, 'DELETE', url)).statusCode).toBe(401);
      const unverified = await account(h, false);
      const res = await call(h, unverified.cookie, 'PUT', url, { kind: 'heart' });
      expect(res.statusCode).toBe(403);
      expect(apiErrorSchema.parse(res.json()).error.code).toBe('email_not_verified');
    });

    it('counts one reaction per user, lets them change it and take it back', async () => {
      const owner = await account(h);
      const alice = await account(h);
      const bob = await account(h);
      const { token } = await sharedTank(h, owner.cookie);
      const url = `/api/public/${token}/reaction`;

      const first = reactionStateSchema.parse(
        (await call(h, alice.cookie, 'PUT', url, { kind: 'heart' })).json(),
      );
      expect(first).toEqual({ reactions: { heart: 1, star: 0, wow: 0 }, myReaction: 'heart' });
      await call(h, bob.cookie, 'PUT', url, { kind: 'heart' });
      const changed = reactionStateSchema.parse(
        (await call(h, alice.cookie, 'PUT', url, { kind: 'wow' })).json(),
      );
      expect(changed).toEqual({ reactions: { heart: 1, star: 0, wow: 1 }, myReaction: 'wow' });

      const anon = publicTankSchema.parse(
        (await call(h, null, 'GET', `/api/public/${token}`)).json(),
      );
      expect(anon.reactions).toEqual({ heart: 1, star: 0, wow: 1 });
      expect(anon.myReaction).toBeNull();
      const asBob = publicTankSchema.parse(
        (await call(h, bob.cookie, 'GET', `/api/public/${token}`)).json(),
      );
      expect(asBob.myReaction).toBe('heart');

      const removed = reactionStateSchema.parse(
        (await call(h, alice.cookie, 'DELETE', url)).json(),
      );
      expect(removed).toEqual({ reactions: { heart: 1, star: 0, wow: 0 }, myReaction: null });
    });

    it('rejects unknown kinds, unknown tokens and the owner’s own tank', async () => {
      const owner = await account(h);
      const guest = await account(h);
      const { token } = await sharedTank(h, owner.cookie);
      const url = `/api/public/${token}/reaction`;
      expect((await call(h, guest.cookie, 'PUT', url, { kind: 'poop' })).statusCode).toBe(400);
      expect(
        (await call(h, guest.cookie, 'PUT', url, { kind: 'heart', extra: 1 })).statusCode,
      ).toBe(400);
      expect(
        (
          await call(h, guest.cookie, 'PUT', `/api/public/${'C'.repeat(43)}/reaction`, {
            kind: 'heart',
          })
        ).statusCode,
      ).toBe(404);
      const own = await call(h, owner.cookie, 'PUT', url, { kind: 'heart' });
      expect(own.statusCode).toBe(403);
      expect(own.json().error.code).toBe('own_tank');
    });

    it('stops counting once the link is revoked', async () => {
      const owner = await account(h);
      const guest = await account(h);
      const { id, token } = await sharedTank(h, owner.cookie);
      await call(h, guest.cookie, 'PUT', `/api/public/${token}/reaction`, { kind: 'star' });
      await call(h, owner.cookie, 'DELETE', `/api/tanks/${id}/share`);
      const res = await call(h, guest.cookie, 'PUT', `/api/public/${token}/reaction`, {
        kind: 'heart',
      });
      expect(res.statusCode).toBe(404);
    });

    it('is exported with the account and deleted with it', async () => {
      const owner = await account(h);
      const guest = await account(h);
      const { id, token } = await sharedTank(h, owner.cookie);
      await call(h, guest.cookie, 'PUT', `/api/public/${token}/reaction`, { kind: 'star' });
      const exported = dataExportSchema.parse(
        (await call(h, guest.cookie, 'POST', '/api/me/export', {})).json(),
      );
      expect(exported.reactions).toHaveLength(1);
      expect(exported.reactions[0]).toMatchObject({ tank: 'Reef corner', kind: 'star' });
      expect(exported.auditLog).toEqual([
        expect.objectContaining({ action: 'reaction_set', tank: 'Reef corner' }),
      ]);
      const dump = JSON.stringify(exported);
      for (const secret of [token, id, hashShareToken(token), owner.userId, owner.email]) {
        expect(dump).not.toContain(secret);
      }

      const deleted = await call(h, guest.cookie, 'POST', '/api/me/delete', { password: PASSWORD });
      expect(deleted.statusCode).toBe(204);
      const left = await h.database.db
        .select()
        .from(schema.tankReactions)
        .where(eq(schema.tankReactions.tankId, id));
      expect(left).toHaveLength(0);
      const audited = await h.database.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actorId, guest.userId));
      expect(audited).toHaveLength(0);
    });

    it('exports the owner’s tank as shared without any token or hash', async () => {
      const owner = await account(h);
      const { token } = await sharedTank(h, owner.cookie);
      const exported = dataExportSchema.parse(
        (await call(h, owner.cookie, 'POST', '/api/me/export', {})).json(),
      );
      expect(exported.tanks[0]?.tank).toMatchObject({ shared: true });
      const dump = JSON.stringify(exported);
      expect(dump).not.toContain(token);
      expect(dump).not.toContain(hashShareToken(token));
    });
  });

  describe('audit', () => {
    it('records share changes and reactions without any token', async () => {
      const owner = await account(h);
      const guest = await account(h);
      const { id, token } = await sharedTank(h, owner.cookie);
      await call(h, owner.cookie, 'POST', `/api/tanks/${id}/share`);
      const rotated = tankSchema.parse(
        (await call(h, owner.cookie, 'POST', `/api/tanks/${id}/share/rotate`)).json(),
      );
      const url = `/api/public/${rotated.shareToken}/reaction`;
      await call(h, guest.cookie, 'PUT', url, { kind: 'wow' });
      await call(h, guest.cookie, 'DELETE', url);
      await call(h, guest.cookie, 'DELETE', url);
      await call(h, owner.cookie, 'DELETE', `/api/tanks/${id}/share`);

      const rows = await h.database.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.tankId, id))
        .orderBy(schema.auditLog.id);
      expect(rows.map((r) => [r.action, r.actorId])).toEqual([
        ['share_enabled', owner.userId],
        ['share_rotated', owner.userId],
        ['reaction_set', guest.userId],
        ['reaction_removed', guest.userId],
        ['share_revoked', owner.userId],
      ]);
      expect(rows[2]?.detail).toEqual({ kind: 'wow' });
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(token);
      expect(dump).not.toContain(rotated.shareToken ?? 'missing');
    });
  });
});

describe('public rate limits', () => {
  it('answers 429 on reads past the per-IP limit', async () => {
    const h = await createHarness({
      publicLimits: {
        view: { max: 2, windowMs: 60_000 },
        react: { max: 2, windowMs: 60_000 },
        reactIp: { max: 50, windowMs: 60_000 },
      },
    });
    try {
      const owner = await account(h);
      const guest = await account(h);
      const { token } = await sharedTank(h, owner.cookie);
      const codes: number[] = [];
      for (let i = 0; i < 3; i++)
        codes.push((await call(h, null, 'GET', `/api/public/${token}`)).statusCode);
      expect(codes).toEqual([200, 200, 429]);

      const url = `/api/public/${token}/reaction`;
      const reacts: number[] = [];
      for (const kind of ['heart', 'star', 'wow'] as const) {
        reacts.push((await call(h, guest.cookie, 'PUT', url, { kind })).statusCode);
      }
      expect(reacts).toEqual([200, 200, 429]);
    } finally {
      await h.close();
    }
  });
});

describe('public link abuse and isolation', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('shows nothing of the owner’s other tanks or their fish', async () => {
    const owner = await account(h);
    const { token } = await sharedTank(h, owner.cookie, 'Front window');
    const other = tankSchema.parse(
      (
        await call(h, owner.cookie, 'POST', '/api/tanks', {
          name: 'Secret hideout',
          biome: 'reef',
        })
      ).json(),
    );
    await call(
      h,
      owner.cookie,
      'POST',
      `/api/tanks/${other.id}/fish`,
      fishPayload('neon-tetra', 'Hidden'),
    );
    const res = await call(h, null, 'GET', `/api/public/${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('Secret hideout');
    expect(res.body).not.toContain('Hidden');
    expect(res.body).not.toContain(other.id);
    expect(publicTankSchema.parse(res.json()).fish).toHaveLength(1);
    expect((await call(h, null, 'GET', `/api/public/${other.id}`)).statusCode).toBe(404);
  });

  it('never counts the same viewer twice, however often they repeat a reaction', async () => {
    const owner = await account(h);
    const guest = await account(h);
    const { token } = await sharedTank(h, owner.cookie);
    const url = `/api/public/${token}/reaction`;
    for (let i = 0; i < 5; i++) await call(h, guest.cookie, 'PUT', url, { kind: 'heart' });
    const rows = await h.database.db.select().from(schema.tankReactions);
    expect(rows.filter((r) => r.userId === guest.userId)).toHaveLength(1);
    const state = reactionStateSchema.parse(
      (await call(h, guest.cookie, 'PUT', url, { kind: 'star' })).json(),
    );
    expect(state.reactions).toEqual({ heart: 0, star: 1, wow: 0 });
  });

  it('rejects a malformed reaction body and a cross-site mutation', async () => {
    const owner = await account(h);
    const guest = await account(h);
    const { token } = await sharedTank(h, owner.cookie);
    const url = `/api/public/${token}/reaction`;
    for (const payload of [{}, { kind: ['heart'] }, { kind: null }, { kind: 'HEART' }]) {
      expect((await call(h, guest.cookie, 'PUT', url, payload)).statusCode).toBe(400);
    }
    const crossSite = await h.app.inject({
      method: 'PUT',
      url,
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        cookie: guest.cookie,
      },
      payload: { kind: 'heart' },
    });
    expect(crossSite.statusCode).toBeGreaterThanOrEqual(400);
    expect(crossSite.statusCode).toBeLessThan(500);
    const rows = await h.database.db.select().from(schema.tankReactions);
    expect(rows.filter((r) => r.userId === guest.userId)).toHaveLength(0);
  });

  it('limits reactions per IP even across different accounts', async () => {
    const limited = await createHarness({
      publicLimits: {
        view: { max: 50, windowMs: 60_000 },
        react: { max: 50, windowMs: 60_000 },
        reactIp: { max: 2, windowMs: 60_000 },
      },
    });
    try {
      const owner = await account(limited);
      const { token } = await sharedTank(limited, owner.cookie);
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const guest = await account(limited);
        codes.push(
          (
            await call(limited, guest.cookie, 'PUT', `/api/public/${token}/reaction`, {
              kind: 'heart',
            })
          ).statusCode,
        );
      }
      expect(codes).toEqual([200, 200, 429]);
    } finally {
      await limited.close();
    }
  });

  it('purges audit entries older than 180 days', async () => {
    const owner = await account(h);
    const { id } = await sharedTank(h, owner.cookie);
    await h.database.db.insert(schema.auditLog).values({
      action: 'share_enabled',
      actorId: owner.userId,
      tankId: id,
      at: new Date(Date.now() - 181 * 86_400_000),
    });
    await pruneExpired(h.database, h.clock);
    const rows = await h.database.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actorId, owner.userId));
    expect(rows).toHaveLength(1);
    expect(Date.now() - (rows[0]?.at.getTime() ?? 0)).toBeLessThan(86_400_000);
  });

  it('throttles guessing: misses count against the per-IP read limit', async () => {
    const limited = await createHarness({
      publicLimits: {
        view: { max: 3, windowMs: 60_000 },
        react: { max: 3, windowMs: 60_000 },
        reactIp: { max: 50, windowMs: 60_000 },
      },
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        codes.push((await call(limited, null, 'GET', `/api/public/${'A'.repeat(43)}`)).statusCode);
      }
      expect(codes).toEqual([404, 404, 404, 429]);
    } finally {
      await limited.close();
    }
  });
});
