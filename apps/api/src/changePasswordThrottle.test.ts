import { sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ORIGIN, createHarness, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const NEXT = 'another correct horse';
const WRONG = 'wrong-password-1';
const MAX = 3;
const json = { 'content-type': 'application/json', origin: APP_ORIGIN };
let counter = 0;

interface Account {
  email: string;
  cookie: string;
}

describe('per-account change-password throttle (#285)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ signInThrottle: { max: MAX, windowMs: 15 * 60_000 } });
  });
  afterAll(() => h.close());

  async function account(): Promise<Account> {
    const email = `t285-${Date.now()}-${counter++}@bas.lu`;
    const signedUp = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: json,
      payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/' },
    });
    const link = /https?:\/\/\S+verify-email\?\S+/.exec(
      h.outbox.find((m) => m.to === email)?.text ?? '',
    )?.[0];
    if (!link) throw new Error('no verification link');
    const url = new URL(link);
    const pending = signedUp.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    await h.app.inject({
      method: 'GET',
      url: url.pathname + url.search,
      headers: { cookie: pending },
    });
    const signedIn = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: json,
      payload: { email, password: PASSWORD },
    });
    const cookie = signedIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    if (!cookie) throw new Error('sign-in set no session cookie');
    return { email, cookie };
  }

  const change = (
    a: Account,
    currentPassword: string,
    newPassword = NEXT,
    extra: Record<string, string> = {},
  ) =>
    h.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { ...json, cookie: a.cookie, ...extra },
      payload: { currentPassword, newPassword },
    });

  const codeOf = (res: LightMyRequestResponse) => (res.json() as { code?: string }).code;

  it('answers 400 for exactly N wrong guesses, then 429 even with the right password', async () => {
    const a = await account();
    for (let i = 0; i < MAX; i++) {
      const res = await change(a, WRONG);
      expect(res.statusCode).toBe(400);
      expect(codeOf(res)).toBe('INVALID_PASSWORD');
    }
    const blocked = await change(a, WRONG);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await change(a, PASSWORD)).statusCode).toBe(429);
  });

  it('is not reset by a foreign-origin 403', async () => {
    const a = await account();
    expect((await change(a, WRONG)).statusCode).toBe(400);
    const foreign = await change(a, WRONG, NEXT, { origin: 'https://evil.example' });
    expect(foreign.statusCode).toBe(403);
    expect((await change(a, WRONG)).statusCode).toBe(400);
    expect((await change(a, WRONG)).statusCode).toBe(400);
    expect((await change(a, PASSWORD)).statusCode).toBe(429);
  });

  it('is not reset by a 400 for a new password that fails validation', async () => {
    const a = await account();
    expect((await change(a, WRONG)).statusCode).toBe(400);
    const tooShort = await change(a, PASSWORD, 'short');
    expect(tooShort.statusCode).toBe(400);
    expect(tooShort.json().error.code).toBe('validation_failed');
    expect((await change(a, WRONG)).statusCode).toBe(400);
    expect((await change(a, WRONG)).statusCode).toBe(400);
    expect((await change(a, PASSWORD)).statusCode).toBe(429);
  });

  it('does not count malformed bodies or requests without a session', async () => {
    const a = await account();
    for (let i = 0; i < MAX + 2; i++) {
      const malformed = await h.app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { ...json, cookie: a.cookie },
        payload: { currentPassword: WRONG },
      });
      expect(malformed.statusCode).toBe(400);
      const anonymous = await h.app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: json,
        payload: { currentPassword: WRONG, newPassword: NEXT },
      });
      expect(anonymous.statusCode).toBe(401);
    }
    expect((await change(a, PASSWORD)).statusCode).toBe(200);
  });

  it('resets the count on a successful change', async () => {
    const a = await account();
    for (let i = 0; i < MAX - 1; i++) expect((await change(a, WRONG)).statusCode).toBe(400);
    expect((await change(a, PASSWORD, NEXT)).statusCode).toBe(200);
    for (let i = 0; i < MAX; i++) expect((await change(a, WRONG)).statusCode).toBe(400);
    expect((await change(a, WRONG)).statusCode).toBe(429);
  });

  it('lets the owner change the password again once the window has passed', async () => {
    const a = await account();
    const [{ maxId }] = (
      await h.database.db.execute(
        sql`select coalesce(max(id), 0)::int as "maxId" from mail_limit_hits`,
      )
    ).rows as [{ maxId: number }];
    for (let i = 0; i < MAX; i++) await change(a, WRONG);
    expect((await change(a, PASSWORD)).statusCode).toBe(429);
    await h.database.db.execute(
      sql`update mail_limit_hits set at = at - interval '16 minutes' where id > ${maxId}`,
    );
    expect((await change(a, PASSWORD)).statusCode).toBe(200);
  });

  it('holds the cap under concurrent guesses', async () => {
    const a = await account();
    const codes = (await Promise.all(Array.from({ length: 20 }, () => change(a, WRONG)))).map(
      (r) => r.statusCode,
    );
    expect(codes.filter((c) => c === 400)).toHaveLength(MAX);
    expect(codes.filter((c) => c === 429)).toHaveLength(20 - MAX);
  });

  it("leaves another user's counter alone", async () => {
    const victim = await account();
    const other = await account();
    for (let i = 0; i < MAX + 1; i++) await change(other, WRONG);
    expect((await change(victim, PASSWORD)).statusCode).toBe(200);
  });

  it('is independent of the sign-in counter for the same email', async () => {
    const a = await account();
    for (let i = 0; i < MAX; i++) await change(a, WRONG);
    const signIn = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: json,
      payload: { email: a.email, password: PASSWORD },
    });
    expect(signIn.statusCode).toBe(200);
  });
});
