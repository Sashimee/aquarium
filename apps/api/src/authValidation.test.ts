import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MAIL_LIMITS } from './mail.ts';
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

const BLOCKED: ['GET' | 'POST', string][] = [
  ['GET', 'list-sessions'],
  ['POST', 'revoke-session'],
  ['POST', 'revoke-sessions'],
  ['POST', 'revoke-other-sessions'],
  ['POST', 'change-email'],
  ['POST', 'delete-user'],
  ['GET', 'delete-user/callback'],
  ['GET', 'account-info'],
  ['POST', 'get-access-token'],
  ['POST', 'refresh-token'],
  ['POST', 'link-social'],
  ['POST', 'unlink-account'],
  ['GET', 'list-accounts'],
  ['POST', 'sign-in/social'],
  ['POST', 'update-session'],
  ['POST', 'verify-password'],
  ['POST', 'passkey/delete-passkey'],
  ['GET', 'passkey/list-user-passkeys'],
  ['POST', 'passkey/update-passkey'],
];

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

  it('stores the trimmed name on update-user', async () => {
    const { email, cookie } = await verifiedSession(h);
    const padded = 'x'.repeat(60) + ' '.repeat(400_000);
    expect((await post(h.app, '/api/auth/update-user', { name: padded }, cookie)).statusCode).toBe(
      200,
    );
    expect((await stored(email)).name).toBe('x'.repeat(60));
    await post(h.app, '/api/auth/update-user', { name: '  Bob  ' }, cookie);
    expect((await stored(email)).name).toBe('Bob');
  });

  it('stores the trimmed name on sign-up', async () => {
    const email = nextEmail();
    const res = await post(h.app, '/api/auth/sign-up/email', {
      email,
      password: PASSWORD,
      name: '  Bob' + ' '.repeat(400_000),
      callbackURL: '/',
    });
    expect(res.statusCode).toBe(200);
    expect((await stored(email)).name).toBe('Bob');
  });

  it.each(BLOCKED)('returns 404 for %s %s', async (method, path) => {
    const { cookie } = await verifiedSession(h);
    const res = await h.app.inject({
      method,
      url: `/api/auth/${path}`,
      headers: { ...jsonHeaders, cookie },
      ...(method === 'POST' ? { payload: '{}' } : {}),
    });
    expect(res.statusCode).toBe(404);
  });

  const cases = [
    ['request-password-reset', 'redirectTo'],
    ['send-verification-email', 'callbackURL'],
  ] as const;

  describe('reset and resend bodies', () => {
    it.each(cases)('rejects bad %s bodies before Better Auth runs', async (path, field) => {
      const before = h.outbox.length;
      const otherField = field === 'redirectTo' ? 'callbackURL' : 'redirectTo';
      for (const body of [
        {},
        { email: nextEmail(), [otherField]: '/' },
        { email: 'nope' },
        { email: `${'x'.repeat(250)}@bas.lu` },
        { email: nextEmail(), [field]: 'x'.repeat(3000) },
        { email: nextEmail(), extra: 1 },
      ]) {
        const res = await post(h.app, `/api/auth/${path}`, body);
        expect(res.statusCode, JSON.stringify(body).slice(0, 40)).toBe(400);
        expect(res.json()).toMatchObject({ error: { code: 'validation_failed' } });
      }
      const malformed = await h.app.inject({
        method: 'POST',
        url: `/api/auth/${path}`,
        headers: jsonHeaders,
        payload: '{nope',
      });
      expect(malformed.statusCode).toBe(400);
      await h.settleMail();
      expect(h.outbox.length).toBe(before);
    });

    it.each(cases)('accepts a good %s body and still rate-limits it', async (path, field) => {
      const limited = await createHarness({
        mailLimits: { ...DEFAULT_MAIL_LIMITS, perIpSignup: { max: 2, windowMs: 60_000 } },
      });
      try {
        const body = { email: nextEmail(), [field]: '/' };
        const statuses: number[] = [];
        for (let i = 0; i < 4; i++) {
          statuses.push((await post(limited.app, `/api/auth/${path}`, body)).statusCode);
        }
        expect(statuses).toEqual([200, 200, 429, 429]);
      } finally {
        await limited.close();
        await limited.dropDatabase();
      }
    });
  });

  it.each(cases)(
    'does not charge the per-IP budget for rejected %s bodies',
    async (path, field) => {
      const limited = await createHarness({
        mailLimits: { ...DEFAULT_MAIL_LIMITS, perIpSignup: { max: 2, windowMs: 60_000 } },
      });
      try {
        for (let i = 0; i < 5; i++) {
          const bad = await post(limited.app, `/api/auth/${path}`, {
            email: 'nope',
          });
          expect(bad.statusCode).toBe(400);
        }
        const good = { email: nextEmail(), [field]: '/' };
        const statuses: number[] = [];
        for (let i = 0; i < 3; i++) {
          statuses.push((await post(limited.app, `/api/auth/${path}`, good)).statusCode);
        }
        expect(statuses).toEqual([200, 200, 429]);
      } finally {
        await limited.close();
        await limited.dropDatabase();
      }
    },
  );

  describe('fragment in the request path', () => {
    let port: number;
    beforeAll(async () => {
      await h.app.listen({ port: 0, host: '127.0.0.1' });
      port = (h.app.server.address() as AddressInfo).port;
    });

    const raw = (method: string, path: string, cookie: string, body?: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method,
            path,
            headers: {
              ...jsonHeaders,
              cookie,
              'content-length': Buffer.byteLength(body ?? ''),
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end(body);
      });

    it('cannot bypass validation, the blocklist or the mail gate', async () => {
      const { email, cookie } = await verifiedSession(h);
      const big = JSON.stringify({ name: 'x'.repeat(1000), image: 'javascript:alert(1)' });
      expect(await raw('POST', '/api/auth/update-user#x', cookie, big)).toBe(404);
      expect((await stored(email)).image).toBeNull();
      for (const [method, path] of BLOCKED) {
        expect(await raw(method, `/api/auth/${path}#x`, cookie, '{}'), path).toBe(404);
      }
      for (const path of [
        'change-password',
        'request-password-reset',
        'sign-up/email',
        'send-verification-email',
      ]) {
        expect(await raw('POST', `/api/auth/${path}#x`, cookie, '{}'), path).toBe(404);
      }
    });
  });
});
