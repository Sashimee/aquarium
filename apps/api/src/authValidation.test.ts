import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ORIGIN, createHarness, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
let counter = 0;
const nextEmail = () => `t118-${Date.now()}-${counter++}@bas.lu`;
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };

const cookieJar = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

async function verifiedSession(h: Harness) {
  const email = nextEmail();
  const signedUp = await h.app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: jsonHeaders,
    payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/' },
  });
  const mail = [...h.outbox].reverse().find((m) => m.to === email);
  const link = /https?:\/\/\S+verify-email\?\S+/.exec(mail?.text ?? '')?.[0];
  if (!link) throw new Error('no verification link in mail');
  const url = new URL(link);
  const verify = await h.app.inject({
    method: 'GET',
    url: url.pathname + url.search,
    headers: { cookie: cookieJar(signedUp) },
  });
  return { email, cookie: cookieJar(verify) };
}

const post = (app: FastifyInstance, url: string, payload: unknown, cookie = '') =>
  app.inject({
    method: 'POST',
    url,
    headers: cookie ? { ...jsonHeaders, cookie } : jsonHeaders,
    payload: JSON.stringify(payload),
  });

describe('Better Auth body validation (#118)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
    await h.dropDatabase();
  });

  const stored = async (email: string) =>
    (await h.database.pool.query('select name, image from "user" where email = $1', [email]))
      .rows[0] as { name: string; image: string | null };

  it('rejects an oversized name and stores nothing', async () => {
    const { email, cookie } = await verifiedSession(h);
    const res = await post(h.app, '/api/auth/update-user', { name: 'x'.repeat(500_000) }, cookie);
    expect(res.statusCode).toBe(400);
    expect((await stored(email)).name).toBe('Tester');
  });

  it('rejects image and unknown fields and stores nothing', async () => {
    const { email, cookie } = await verifiedSession(h);
    for (const body of [
      { name: 'Ok', image: 'javascript:alert(1)' },
      { image: 'javascript:alert(1)' },
      { name: 'Ok', emailVerified: false },
    ]) {
      const res = await post(h.app, '/api/auth/update-user', body, cookie);
      expect(res.statusCode).toBe(400);
    }
    expect(await stored(email)).toEqual({ name: 'Tester', image: null });
  });

  it('rejects malformed JSON', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/update-user',
      headers: jsonHeaders,
      payload: '{nope',
    });
    expect(res.statusCode).toBe(400);
  });

  it('still accepts a valid name update', async () => {
    const { email, cookie } = await verifiedSession(h);
    const res = await post(h.app, '/api/auth/update-user', { name: 'Renamed' }, cookie);
    expect(res.statusCode).toBe(200);
    expect((await stored(email)).name).toBe('Renamed');
  });

  it('rejects bad sign-in bodies and accepts the client shape', async () => {
    const { email } = await verifiedSession(h);
    for (const body of [
      { email, password: 'x'.repeat(5000) },
      { email: 'nope', password: PASSWORD },
      { email, password: '' },
      { email, password: PASSWORD, extra: 1 },
    ]) {
      expect((await post(h.app, '/api/auth/sign-in/email', body)).statusCode).toBe(400);
    }
    const ok = await post(h.app, '/api/auth/sign-in/email', {
      email,
      password: PASSWORD,
      callbackURL: '/',
    });
    expect(ok.statusCode).toBe(200);
  });

  it('rejects bad change-password bodies', async () => {
    const { cookie } = await verifiedSession(h);
    for (const body of [
      { currentPassword: PASSWORD, newPassword: 'short' },
      { currentPassword: PASSWORD, newPassword: 'x'.repeat(5000) },
      { newPassword: 'another long password' },
      { currentPassword: PASSWORD, newPassword: 'another long password', extra: true },
    ]) {
      expect((await post(h.app, '/api/auth/change-password', body, cookie)).statusCode).toBe(400);
    }
    const ok = await post(
      h.app,
      '/api/auth/change-password',
      { currentPassword: PASSWORD, newPassword: 'another long password' },
      cookie,
    );
    expect(ok.statusCode).toBe(200);
  });

  it('returns 404 for endpoints the app does not use', async () => {
    const { cookie } = await verifiedSession(h);
    for (const path of [
      'delete-user',
      'change-email',
      'revoke-sessions',
      'passkey/delete-passkey',
    ]) {
      const res = await post(h.app, `/api/auth/${path}`, {}, cookie);
      expect(res.statusCode, path).toBe(404);
    }
  });
});
