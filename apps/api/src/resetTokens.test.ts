import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ORIGIN, createHarness, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'another horse staple 42';
const headers = { 'content-type': 'application/json', origin: APP_ORIGIN };
let counter = 0;
const nextEmail = () => `t132-${Date.now()}-${counter++}@bas.lu`;

describe('reset and verification token hygiene (#132)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const post = (url: string, payload: Record<string, string>): Promise<LightMyRequestResponse> =>
    h.app.inject({ method: 'POST', url, headers, payload });

  async function signedUp() {
    const email = nextEmail();
    await post('/api/auth/sign-up/email', {
      email,
      password: PASSWORD,
      name: 'Tester',
      callbackURL: '/',
    });
    await h.settleMail();
    const text = h.outbox.find((m) => m.to === email)?.text ?? '';
    const link = /https?:\/\/\S+verify-email\?\S+/.exec(text)?.[0];
    if (!link) throw new Error('no verification link in mail');
    const url = new URL(link);
    return { email, verifyPath: url.pathname + url.search };
  }

  async function verifiedUser() {
    const user = await signedUp();
    await h.app.inject({ method: 'GET', url: user.verifyPath });
    return user;
  }

  async function requestReset(email: string): Promise<string> {
    const before = h.outbox.filter((m) => m.to === email).length;
    await post('/api/auth/request-password-reset', { email, redirectTo: '/' });
    await h.settleMail();
    const mail = h.outbox.filter((m) => m.to === email).slice(before)[0];
    const token = /reset-password\/([A-Za-z0-9]+)/.exec(mail?.text ?? '')?.[1];
    if (!token) throw new Error('no reset token in mail');
    return token;
  }

  const storedIdentifiers = async () => {
    const { rows } = await h.database.pool.query<{ identifier: string }>(
      'select identifier from verification',
    );
    return rows.map((r) => r.identifier);
  };

  it('invalidates the other outstanding reset tokens once one is used', async () => {
    const { email } = await verifiedUser();
    const first = await requestReset(email);
    const second = await requestReset(email);

    const used = await post('/api/auth/reset-password', {
      newPassword: NEW_PASSWORD,
      token: first,
    });
    expect(used.statusCode).toBe(200);

    const replay = await post('/api/auth/reset-password', {
      newPassword: 'attacker password 99',
      token: second,
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ code: 'INVALID_TOKEN' });

    const signIn = await post('/api/auth/sign-in/email', { email, password: NEW_PASSWORD });
    expect(signIn.statusCode).toBe(200);
  });

  it('leaves another user reset token alone', async () => {
    const mine = await verifiedUser();
    const theirs = await verifiedUser();
    const mineToken = await requestReset(mine.email);
    const theirToken = await requestReset(theirs.email);

    await post('/api/auth/reset-password', { newPassword: NEW_PASSWORD, token: mineToken });

    const res = await post('/api/auth/reset-password', {
      newPassword: NEW_PASSWORD,
      token: theirToken,
    });
    expect(res.statusCode).toBe(200);
  });

  it('keeps the reset link and callback redirect working', async () => {
    const { email } = await verifiedUser();
    const token = await requestReset(email);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/auth/reset-password/${token}?callbackURL=%2F`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toContain(`token=${token}`);
  });

  it('stores no raw reset token in the verification table', async () => {
    const { email } = await verifiedUser();
    const token = await requestReset(email);

    const identifiers = await storedIdentifiers();
    expect(identifiers.length).toBeGreaterThan(0);
    expect(identifiers.some((id) => id.includes(token))).toBe(false);
    expect(identifiers.some((id) => id.startsWith('reset-password:'))).toBe(false);
  });

  it('still verifies an email address from the mailed link', async () => {
    const { email, verifyPath } = await signedUp();
    const res = await h.app.inject({ method: 'GET', url: verifyPath });
    expect(res.statusCode).toBe(302);
    const { rows } = await h.database.pool.query<{ email_verified: boolean }>(
      'select email_verified from "user" where email = $1',
      [email],
    );
    expect(rows[0]?.email_verified).toBe(true);
  });
});
