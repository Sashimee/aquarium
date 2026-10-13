import { sql } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { postgresHitStore } from './rate-limit.ts';
import { loadCatalog } from './species.ts';
import { APP_ORIGIN, createHarness, TEST_SECRET, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const WRONG = 'wrong-password-1';
const MAX = 3;
const LIMIT = { max: MAX, windowMs: 15 * 60_000 };
const headers = { 'content-type': 'application/json', origin: APP_ORIGIN };
let counter = 0;
const nextEmail = () => `t121-${Date.now()}-${counter++}@bas.lu`;

const signIn = (app: FastifyInstance, email: string, password: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers,
    payload: { email, password },
  });

const observable = (res: LightMyRequestResponse) => ({
  status: res.statusCode,
  body: res.body,
  headerNames: Object.keys(res.headers).sort(),
});

const retryAfter = (res: LightMyRequestResponse) => Number(res.headers['retry-after']);

describe('per-account sign-in throttle (#121)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ signInThrottle: LIMIT });
  });
  afterAll(() => h.close());

  async function verifiedUser(): Promise<string> {
    const email = nextEmail();
    const signedUp = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers,
      payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/' },
    });
    const mail = h.outbox.find((m) => m.to === email);
    const link = /https?:\/\/\S+verify-email\?\S+/.exec(mail?.text ?? '')?.[0];
    if (!link) throw new Error('no verification link');
    const url = new URL(link);
    const cookie = signedUp.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    await h.app.inject({ method: 'GET', url: url.pathname + url.search, headers: { cookie } });
    return email;
  }

  it('answers 401 for exactly N failures and 429 from the next attempt, even with the right password', async () => {
    const email = await verifiedUser();
    for (let i = 0; i < MAX; i++) {
      expect((await signIn(h.app, email, WRONG)).statusCode).toBe(401);
    }
    expect((await signIn(h.app, email, WRONG)).statusCode).toBe(429);
    expect((await signIn(h.app, email, PASSWORD)).statusCode).toBe(429);
  });

  it('is case insensitive on the email', async () => {
    const email = await verifiedUser();
    for (let i = 0; i < MAX; i++) await signIn(h.app, email.toUpperCase(), WRONG);
    expect((await signIn(h.app, email, PASSWORD)).statusCode).toBe(429);
  });

  it('gives an unknown email the same 429 as a known one', async () => {
    const known = await verifiedUser();
    const unknown = nextEmail();
    for (let i = 0; i < MAX; i++) {
      await signIn(h.app, known, WRONG);
      await signIn(h.app, unknown, WRONG);
    }
    const a = await signIn(h.app, known, WRONG);
    const b = await signIn(h.app, unknown, WRONG);
    expect(a.statusCode).toBe(429);
    expect(observable(a)).toEqual(observable(b));
    expect(Math.abs(retryAfter(a) - retryAfter(b))).toBeLessThanOrEqual(1);
  });

  it('lets sign-in work again once the window has passed', async () => {
    const email = await verifiedUser();
    const [{ maxId }] = (
      await h.database.db.execute(
        sql`select coalesce(max(id), 0)::int as "maxId" from mail_limit_hits`,
      )
    ).rows as [{ maxId: number }];
    for (let i = 0; i < MAX; i++) await signIn(h.app, email, WRONG);
    expect((await signIn(h.app, email, PASSWORD)).statusCode).toBe(429);
    await h.database.db.execute(
      sql`update mail_limit_hits set at = at - interval '16 minutes' where id > ${maxId}`,
    );
    expect((await signIn(h.app, email, PASSWORD)).statusCode).toBe(200);
  });

  describe.each([
    ['INVALID_CALLBACK_URL', { origin: APP_ORIGIN }, 'https://evil.example/'],
    ['INVALID_ORIGIN', { origin: 'https://evil.example' }, undefined],
    [
      'CROSS_SITE_NAVIGATION_LOGIN_BLOCKED',
      { origin: APP_ORIGIN, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
      undefined,
    ],
  ])('403 %s from Better Auth', (code, extra, callbackURL) => {
    it('is not reset by it, and still counts against the cap', async () => {
      const email = await verifiedUser();
      const junk = () =>
        h.app.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers: { 'content-type': 'application/json', ...extra },
          payload: { email, password: WRONG, ...(callbackURL ? { callbackURL } : {}) },
        });
      const first = await junk();
      expect(first.statusCode).toBe(403);
      expect(first.json().code).toBe(code);
      expect((await signIn(h.app, email, WRONG)).statusCode).toBe(401);
      const second = await junk();
      expect(second.statusCode).toBe(403);
      expect(second.json().code).toBe(code);
      expect((await signIn(h.app, email, PASSWORD)).statusCode).toBe(429);
    });
  });

  it('does not let one account lock out another', async () => {
    const victim = await verifiedUser();
    const other = await verifiedUser();
    for (let i = 0; i < MAX; i++) await signIn(h.app, other, WRONG);
    expect((await signIn(h.app, victim, PASSWORD)).statusCode).toBe(200);
  });

  it('resets the count on a successful sign-in', async () => {
    const email = await verifiedUser();
    for (let i = 0; i < MAX - 1; i++) await signIn(h.app, email, WRONG);
    expect((await signIn(h.app, email, PASSWORD)).statusCode).toBe(200);
    for (let i = 0; i < MAX; i++) {
      expect((await signIn(h.app, email, WRONG)).statusCode).toBe(401);
    }
  });

  it('does not let concurrent failures past the cap', async () => {
    const email = await verifiedUser();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => signIn(h.app, email, WRONG)),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(MAX);
    expect(codes.filter((c) => c === 429)).toHaveLength(20 - MAX);
  });

  it('keeps the count across an app rebuild', async () => {
    const email = await verifiedUser();
    for (let i = 0; i < MAX; i++) await signIn(h.app, email, WRONG);
    const rebuilt = buildApp({
      indexable: false,
      webRoot: '/nonexistent',
      appOrigin: APP_ORIGIN,
      trustedProxies: ['127.0.0.1'],
      database: h.database,
      auth: h.auth,
      mailer: h.mailer,
      signInThrottle: { store: postgresHitStore(h.database, TEST_SECRET), limit: LIMIT },
      species: loadCatalog(),
      logger: false,
    });
    await rebuilt.ready();
    try {
      expect((await signIn(rebuilt, email, PASSWORD)).statusCode).toBe(429);
    } finally {
      await rebuilt.close();
    }
  });
});
