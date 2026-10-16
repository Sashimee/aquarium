import { randomUUID } from 'node:crypto';
import { apiErrorSchema, dataExportSchema, handleResponseSchema } from '@aquarium/shared';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from './db/index.ts';
import { APP_ORIGIN, createHarness, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

async function account(h: Harness, verify = true) {
  const email = `t30-${Date.now()}-${counter++}@bas.lu`;
  const signedUp = await h.app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: jsonHeaders,
    payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/verify-email' },
  });
  expect(signedUp.statusCode).toBe(200);
  const [user] = await h.database.db.select().from(schema.user).where(eq(schema.user.email, email));
  if (!user) throw new Error('user missing');
  const mail = h.outbox.findLast((m) => m.to === email);
  const link = /https?:\/\/\S+verify-email\?\S+/.exec(mail?.text ?? '')?.[0];
  if (!link) throw new Error('no verification link');
  const url = new URL(link);
  const verified = await h.app.inject({
    method: 'GET',
    url: url.pathname + url.search,
    headers: { cookie: cookieOf(signedUp) },
  });
  const cookie = cookieOf(verified);
  if (!cookie) throw new Error('verification did not sign in');
  if (!verify) {
    await h.database.db
      .update(schema.user)
      .set({ emailVerified: false })
      .where(eq(schema.user.id, user.id));
  }
  return { cookie, userId: user.id };
}

const call = (
  h: Harness,
  cookie: string | null,
  method: 'GET' | 'PUT' | 'POST',
  url: string,
  payload?: object,
) =>
  h.app.inject({
    method,
    url,
    headers: { ...jsonHeaders, ...(cookie ? { cookie } : {}) },
    ...(payload ? { payload } : {}),
  });

const unique = () => `u${randomUUID().replaceAll('-', '').slice(0, 12)}`;

describe('public handle', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('needs a session', async () => {
    expect((await call(h, null, 'GET', '/api/me/handle')).statusCode).toBe(401);
    expect((await call(h, null, 'PUT', '/api/me/handle', { handle: unique() })).statusCode).toBe(
      401,
    );
  });

  it('starts empty, then sets and changes the handle', async () => {
    const { cookie } = await account(h);
    expect(
      handleResponseSchema.parse((await call(h, cookie, 'GET', '/api/me/handle')).json()),
    ).toEqual({ handle: null });
    const first = unique();
    const set = await call(h, cookie, 'PUT', '/api/me/handle', { handle: first });
    expect(set.statusCode).toBe(200);
    expect(handleResponseSchema.parse(set.json()).handle).toBe(first);
    const second = unique();
    await call(h, cookie, 'PUT', '/api/me/handle', { handle: second });
    expect(
      handleResponseSchema.parse((await call(h, cookie, 'GET', '/api/me/handle')).json()).handle,
    ).toBe(second);
  });

  it('refuses a taken handle with 409, even for another user', async () => {
    const alice = await account(h);
    const bob = await account(h);
    const handle = unique();
    expect((await call(h, alice.cookie, 'PUT', '/api/me/handle', { handle })).statusCode).toBe(200);
    const clash = await call(h, bob.cookie, 'PUT', '/api/me/handle', { handle });
    expect(clash.statusCode).toBe(409);
    expect(apiErrorSchema.parse(clash.json()).error.code).toBe('conflict');
  });

  it('refuses blocked, reserved and malformed handles with 400', async () => {
    const { cookie } = await account(h);
    for (const handle of ['fuck_you', 'sh1thead', 'admin', 'AB', 'a b c', 'x']) {
      const res = await call(h, cookie, 'PUT', '/api/me/handle', { handle });
      expect(res.statusCode, handle).toBe(400);
    }
    expect(
      (await call(h, cookie, 'PUT', '/api/me/handle', { handle: 'nemo', extra: 1 })).statusCode,
    ).toBe(400);
  });

  it('needs a verified email', async () => {
    const { cookie } = await account(h, false);
    const res = await call(h, cookie, 'PUT', '/api/me/handle', { handle: unique() });
    expect(res.statusCode).toBe(403);
  });

  it('appears in the data export and is deleted with the account', async () => {
    const { cookie, userId } = await account(h);
    const handle = unique();
    await call(h, cookie, 'PUT', '/api/me/handle', { handle });

    const exported = dataExportSchema.parse(
      (await call(h, cookie, 'POST', '/api/me/export', {})).json(),
    );
    expect(exported.user.handle).toBe(handle);

    const deleted = await call(h, cookie, 'POST', '/api/me/delete', { password: PASSWORD });
    expect(deleted.statusCode).toBe(204);
    const rows = await h.database.db
      .select()
      .from(schema.user)
      .where(eq(schema.user.handle, handle));
    expect(rows).toHaveLength(0);
    expect(
      await h.database.db.select().from(schema.user).where(eq(schema.user.id, userId)),
    ).toHaveLength(0);
  });

  it('holds a deleted account’s handle for the cooldown too', async () => {
    const alice = await account(h);
    const handle = unique();
    await call(h, alice.cookie, 'PUT', '/api/me/handle', { handle });
    await call(h, alice.cookie, 'POST', '/api/me/delete', { password: PASSWORD });
    const bob = await account(h);
    expect((await call(h, bob.cookie, 'PUT', '/api/me/handle', { handle })).statusCode).toBe(409);
    await h.database.pool.query(
      `update released_handles set released_at = now() - interval '31 days' where handle = $1`,
      [handle],
    );
    expect((await call(h, bob.cookie, 'PUT', '/api/me/handle', { handle })).statusCode).toBe(200);
  });

  it('holds a released handle for the cooldown, then frees it', async () => {
    const alice = await account(h);
    const bob = await account(h);
    const old = unique();
    await call(h, alice.cookie, 'PUT', '/api/me/handle', { handle: old });
    await call(h, alice.cookie, 'PUT', '/api/me/handle', { handle: unique() });
    const early = await call(h, bob.cookie, 'PUT', '/api/me/handle', { handle: old });
    expect(early.statusCode).toBe(409);
    await h.database.pool.query(
      `update released_handles set released_at = now() - interval '31 days' where handle = $1`,
      [old],
    );
    expect((await call(h, bob.cookie, 'PUT', '/api/me/handle', { handle: old })).statusCode).toBe(
      200,
    );
  });

  it('keeps stored handles readable after the filter learns new words', async () => {
    const { cookie, userId } = await account(h);
    await h.database.db
      .update(schema.user)
      .set({ handle: 'admin' })
      .where(eq(schema.user.id, userId));
    const res = await call(h, cookie, 'GET', '/api/me/handle');
    expect(res.statusCode).toBe(200);
    expect(handleResponseSchema.parse(res.json()).handle).toBe('admin');
  });
});

describe('handle rate limit', () => {
  it('answers 429 past the limit, and rejected input spends none of it', async () => {
    const h = await createHarness({ handleLimit: { max: 2, windowMs: 60_000 } });
    try {
      const { cookie } = await account(h);
      for (let i = 0; i < 5; i++) {
        expect(
          (await call(h, cookie, 'PUT', '/api/me/handle', { handle: 'fuck' })).statusCode,
        ).toBe(400);
      }
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        codes.push(
          (await call(h, cookie, 'PUT', '/api/me/handle', { handle: unique() })).statusCode,
        );
      }
      expect(codes).toEqual([200, 200, 429]);
    } finally {
      await h.close();
    }
  });
});
