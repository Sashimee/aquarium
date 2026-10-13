import { apiErrorSchema, sessionListSchema, userSchema } from '@aquarium/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { postgresHitStore } from './rate-limit.ts';
import { APP_ORIGIN, createHarness, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
let counter = 0;
const nextEmail = () => `t06-${Date.now()}-${counter++}@bas.lu`;

const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };

function cookieJar(res: LightMyRequestResponse): string {
  return res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function signUp(app: FastifyInstance, email: string, extra: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { ...jsonHeaders, ...extra },
    payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/' },
  });
}

function verificationPath(h: Harness, email: string): string {
  const mail = [...h.outbox].reverse().find((m) => m.to === email);
  if (!mail) throw new Error('no mail for recipient');
  const url = /https?:\/\/\S+verify-email\?\S+/.exec(mail.text)?.[0];
  if (!url) throw new Error('no verification link in mail');
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

function verifyFrom(h: Harness, email: string, signedUpWith?: LightMyRequestResponse) {
  const cookie = signedUpWith ? cookieJar(signedUpWith) : '';
  return h.app.inject({
    method: 'GET',
    url: verificationPath(h, email),
    headers: cookie ? { cookie } : {},
  });
}

async function verifiedSession(h: Harness, email = nextEmail()) {
  const signedUp = await signUp(h.app, email);
  const verify = await verifyFrom(h, email, signedUp);
  const cookie = cookieJar(verify);
  expect(cookie).not.toBe('');
  return { email, cookie, verify };
}

describe('unverified sign-up takeover (#114)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const ATTACKER_PASSWORD = 'attacker-pass-123';
  const VICTIM_PASSWORD = 'victim-pass-1234';

  const signInWith = (email: string, password: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: jsonHeaders,
      payload: { email, password },
    });

  const signUpWith = (email: string, password: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: jsonHeaders,
      payload: { email, password, name: 'Someone', callbackURL: '/' },
    });

  const requestReset = (email: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      headers: jsonHeaders,
      payload: { email, redirectTo: '/' },
    });

  function resetToken(email: string): string {
    const mail = [...h.outbox].reverse().find((m) => m.to === email && /reset/i.test(m.subject));
    if (!mail) throw new Error('no reset mail for recipient');
    const token = /reset-password\/([A-Za-z0-9]+)/.exec(mail.text)?.[1];
    if (!token) throw new Error('no reset token in mail');
    return token;
  }

  it('does not let the attacker password work after the owner clicks the sign-up mail', async () => {
    const email = nextEmail();
    const attacker = await signUpWith(email, ATTACKER_PASSWORD);
    expect(attacker.statusCode).toBe(200);

    const verify = await verifyFrom(h, email);
    expect(verify.statusCode).toBe(302);

    expect((await signInWith(email, ATTACKER_PASSWORD)).statusCode).toBe(401);
  });

  it('does not let the attacker password work after the owner clicks a sign-in mail', async () => {
    const email = nextEmail();
    await signUpWith(email, ATTACKER_PASSWORD);
    const blocked = await signInWith(email, ATTACKER_PASSWORD);
    expect(blocked.statusCode).toBe(403);
    expect(h.outbox.filter((m) => m.to === email)).toHaveLength(2);

    await verifyFrom(h, email);

    expect((await signInWith(email, ATTACKER_PASSWORD)).statusCode).toBe(401);
  });

  it('revokes every session of the account at first verification', async () => {
    const email = nextEmail();
    await signUpWith(email, ATTACKER_PASSWORD);
    const user = await h.database.pool.query('select id from "user" where email = $1', [email]);
    const userId = String(user.rows[0].id);
    await h.database.pool.query(
      `insert into session (id, user_id, token, expires_at, created_at, updated_at)
       values ('planted', $1, 'planted-token', now() + interval '1 day', now(), now())`,
      [userId],
    );
    await verifyFrom(h, email);
    const left = await h.database.pool.query('select 1 from session where id = $1', ['planted']);
    expect(left.rowCount).toBe(0);
  });

  it('keeps the password of an honest single sign-up verified in the same browser', async () => {
    const email = nextEmail();
    const signedUp = await signUpWith(email, VICTIM_PASSWORD);
    await verifyFrom(h, email, signedUp);
    expect((await signInWith(email, VICTIM_PASSWORD)).statusCode).toBe(200);
  });

  it('does not let a cookie from another account carry over', async () => {
    const email = nextEmail();
    await signUpWith(email, ATTACKER_PASSWORD);
    const unrelated = await signUpWith(nextEmail(), VICTIM_PASSWORD);
    await verifyFrom(h, email, unrelated);
    expect((await signInWith(email, ATTACKER_PASSWORD)).statusCode).toBe(401);
  });

  it('answers a repeat sign-up like a fresh one and mails the address again', async () => {
    const email = nextEmail();
    const first = await signUpWith(email, ATTACKER_PASSWORD);
    const second = await signUpWith(email, VICTIM_PASSWORD);
    expect(second.statusCode).toBe(first.statusCode);
    expect(Object.keys(second.json())).toEqual(Object.keys(first.json()));
    expect(h.outbox.filter((m) => m.to === email)).toHaveLength(2);
  });

  it('responds to a repeat sign-up in about the time of a fresh one', async () => {
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0;
    const time = async (email: string) => {
      const start = performance.now();
      await signUpWith(email, ATTACKER_PASSWORD);
      return performance.now() - start;
    };
    const fresh: number[] = [];
    const repeat: number[] = [];
    for (let i = 0; i < 5; i++) {
      const email = nextEmail();
      fresh.push(await time(email));
      repeat.push(await time(email));
    }
    expect(Math.abs(median(repeat) - median(fresh))).toBeLessThan(150);
  });

  it('lets the owner set a password by reset, revoking sessions, and leaves verified accounts intact', async () => {
    const email = nextEmail();
    await signUpWith(email, ATTACKER_PASSWORD);
    await signUpWith(email, VICTIM_PASSWORD);
    const verify = await verifyFrom(h, email);
    const ownerCookie = cookieJar(verify);

    expect((await requestReset(email)).statusCode).toBe(200);
    const reset = await h.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      headers: jsonHeaders,
      payload: { newPassword: VICTIM_PASSWORD, token: resetToken(email) },
    });
    expect(reset.statusCode).toBe(200);

    expect(
      (await h.app.inject({ url: '/api/me', headers: { cookie: ownerCookie } })).statusCode,
    ).toBe(401);
    expect((await signInWith(email, ATTACKER_PASSWORD)).statusCode).toBe(401);
    expect((await signInWith(email, VICTIM_PASSWORD)).statusCode).toBe(200);

    await signUpWith(email, ATTACKER_PASSWORD);
    expect((await signInWith(email, VICTIM_PASSWORD)).statusCode).toBe(200);
    expect((await signInWith(email, ATTACKER_PASSWORD)).statusCode).toBe(401);
  });

  describe('reset on an unverified account (#139)', () => {
    const resetPassword = (email: string, newPassword: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        headers: jsonHeaders,
        payload: { newPassword, token: resetToken(email) },
      });

    it('keeps the reset password through a later verification', async () => {
      const email = nextEmail();
      await signUpWith(email, ATTACKER_PASSWORD);
      const link = verificationPath(h, email);
      await requestReset(email);
      expect((await resetPassword(email, VICTIM_PASSWORD)).statusCode).toBe(200);
      expect((await signInWith(email, ATTACKER_PASSWORD)).statusCode).toBe(401);
      expect((await signInWith(email, VICTIM_PASSWORD)).statusCode).toBe(200);
      expect((await h.app.inject({ method: 'GET', url: link })).statusCode).toBe(302);
      expect((await signInWith(email, VICTIM_PASSWORD)).statusCode).toBe(200);
    });

    it('marks the address verified and signs the attacker session out', async () => {
      const email = nextEmail();
      const attacker = await signUpWith(email, ATTACKER_PASSWORD);
      await h.database.pool.query(
        `insert into session (id, user_id, token, expires_at, created_at, updated_at)
         select 'atk-' || id, id, 'atk-token-' || id, now() + interval '1 day', now(), now()
         from "user" where email = $1`,
        [email],
      );
      await requestReset(email);
      await resetPassword(email, VICTIM_PASSWORD);
      const row = await h.database.pool.query(
        'select u.email_verified, (select count(*) from session s where s.user_id = u.id) as sessions from "user" u where email = $1',
        [email],
      );
      expect(row.rows[0].email_verified).toBe(true);
      expect(Number(row.rows[0].sessions)).toBe(0);
      expect(
        (await h.app.inject({ url: '/api/me', headers: { cookie: cookieJar(attacker) } }))
          .statusCode,
      ).toBe(401);
    });

    it('does not drop the new credential when an old verification link is clicked', async () => {
      const email = nextEmail();
      await signUpWith(email, ATTACKER_PASSWORD);
      const oldLink = verificationPath(h, email);
      await requestReset(email);
      await resetPassword(email, VICTIM_PASSWORD);
      const click = await h.app.inject({ method: 'GET', url: oldLink });
      expect(click.statusCode).toBe(302);
      expect((await signInWith(email, VICTIM_PASSWORD)).statusCode).toBe(200);
    });
  });

  it('answers a reset request for an unknown address the same way and sends nothing', async () => {
    const email = nextEmail();
    expect((await requestReset(email)).statusCode).toBe(200);
    expect(h.outbox.filter((m) => m.to === email)).toHaveLength(0);
  });
});

describe('email + password', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('sends one verification mail from the aligned sender to the recipient only', async () => {
    const email = nextEmail();
    const res = await signUp(h.app, email);
    expect(res.statusCode).toBe(200);
    const mails = h.outbox.filter((m) => m.to === email);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.from).toBe('Aquarium <fish@bas.lu>');
    expect(mails[0]?.text).toContain('/api/auth/verify-email?token=');
    expect(res.cookies.some((c) => c.name.includes('session_token'))).toBe(false);
  });

  it('refuses sign-in until the email is verified, then allows it', async () => {
    const email = nextEmail();
    const signedUp = await signUp(h.app, email);
    const blocked = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: jsonHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.cookies).toHaveLength(0);

    await verifyFrom(h, email, signedUp);
    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: jsonHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.cookies.length).toBeGreaterThan(0);
  });

  it('rejects passwords shorter than the shared contract minimum', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: jsonHeaders,
      payload: { email: nextEmail(), password: '123456789', name: 'Short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a wrong password', async () => {
    const { email } = await verifiedSession(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: jsonHeaders,
      payload: { email, password: 'not the password' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('sets HttpOnly, Secure, SameSite=Lax session cookies', async () => {
    const { verify } = await verifiedSession(h);
    const session = verify.cookies.find((c) => c.name.includes('session_token'));
    expect(session).toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(session?.secure).toBe(true);
    expect(session?.sameSite).toBe('Lax');
    const raw = [verify.headers['set-cookie']].flat().join('\n');
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/SameSite=Lax/i);
  });

  it('returns the current user on /api/me and 401 without a session', async () => {
    const { email, cookie } = await verifiedSession(h);
    const me = await h.app.inject({ url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const user = userSchema.parse(me.json());
    expect(user.email).toBe(email);
    expect(user.emailVerified).toBe(true);

    const anon = await h.app.inject('/api/me');
    expect(anon.statusCode).toBe(401);
    expect(apiErrorSchema.parse(anon.json()).error.code).toBe('unauthenticated');
  });
});

describe('sessions', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  async function signIn(email: string, userAgent: string) {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { ...jsonHeaders, 'user-agent': userAgent },
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return cookieJar(res);
  }

  it('lists sessions without leaking tokens and flags the current one', async () => {
    const { email, cookie: first } = await verifiedSession(h);
    const second = await signIn(email, 'second-device');
    const res = await h.app.inject({ url: '/api/sessions', headers: { cookie: second } });
    expect(res.statusCode).toBe(200);
    const list = sessionListSchema.parse(res.json());
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.find((s) => s.current)?.userAgent).toBe('second-device');
    expect(res.body).not.toContain(first.split('=')[1]?.split('.')[0] ?? 'unreachable');
  });

  it('does not expose the native token-bearing session list', async () => {
    const { cookie } = await verifiedSession(h);
    const res = await h.app.inject({ url: '/api/auth/list-sessions', headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it('revokes another session, which then stops authenticating', async () => {
    const { email, cookie: first } = await verifiedSession(h);
    const second = await signIn(email, 'second-device');
    const list = sessionListSchema.parse(
      (await h.app.inject({ url: '/api/sessions', headers: { cookie: second } })).json(),
    );
    const other = list.find((s) => !s.current);
    expect(other).toBeDefined();

    const revoke = await h.app.inject({
      method: 'POST',
      url: '/api/sessions/revoke',
      headers: { ...jsonHeaders, cookie: second },
      payload: { sessionId: other?.id },
    });
    expect(revoke.statusCode).toBe(204);

    expect((await h.app.inject({ url: '/api/me', headers: { cookie: second } })).statusCode).toBe(
      200,
    );
    expect((await h.app.inject({ url: '/api/me', headers: { cookie: first } })).statusCode).toBe(
      401,
    );
  });

  it("cannot revoke another user's session", async () => {
    const a = await verifiedSession(h);
    const b = await verifiedSession(h);
    const aList = sessionListSchema.parse(
      (await h.app.inject({ url: '/api/sessions', headers: { cookie: a.cookie } })).json(),
    );
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/sessions/revoke',
      headers: { ...jsonHeaders, cookie: b.cookie },
      payload: { sessionId: aList[0]?.id },
    });
    expect(res.statusCode).toBe(404);
    expect((await h.app.inject({ url: '/api/me', headers: { cookie: a.cookie } })).statusCode).toBe(
      200,
    );
  });

  it('validates the revoke body against the shared contract', async () => {
    const { cookie } = await verifiedSession(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/sessions/revoke',
      headers: { ...jsonHeaders, cookie },
      payload: { sessionId: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('validation_failed');
  });
});

describe('csrf', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it.each([
    ['a foreign origin', { origin: 'https://evil.example' }],
    ['no origin', {}],
  ])('rejects cookie-bearing mutations with %s', async (_label, extra) => {
    const { cookie } = await verifiedSession(h);
    const headers = { 'content-type': 'application/json', cookie, ...extra };
    for (const url of ['/api/sessions/revoke', '/api/auth/sign-out']) {
      const res = await h.app.inject({ method: 'POST', url, headers, payload: {} });
      expect(res.statusCode, url).toBe(403);
    }
    expect((await h.app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
  });

  it('accepts the same mutation from the app origin', async () => {
    const { cookie } = await verifiedSession(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { ...jsonHeaders, cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect((await h.app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('mail abuse limits', () => {
  it('applies a cooldown to verification resends', async () => {
    const h = await createHarness({
      mailLimits: {
        perRecipient: { max: 100, windowMs: 3_600_000 },
        verificationCooldown: { max: 1, windowMs: 60_000 },
        perIpSignup: { max: 100, windowMs: 3_600_000 },
        global: { max: 1000, windowMs: 3_600_000 },
      },
    });
    const email = nextEmail();
    await signUp(h.app, email);
    expect(h.outbox.filter((m) => m.to === email)).toHaveLength(1);

    const resend = await h.app.inject({
      method: 'POST',
      url: '/api/auth/send-verification-email',
      headers: jsonHeaders,
      payload: { email, callbackURL: '/' },
    });
    expect(resend.statusCode).toBe(429);
    expect(Number(resend.headers['retry-after'])).toBeGreaterThan(0);
    expect(apiErrorSchema.parse(resend.json()).error.code).toBe('rate_limited');
    expect(h.outbox.filter((m) => m.to === email)).toHaveLength(1);
    await h.close();
  });

  it('caps mails per recipient even when the cooldown has passed', async () => {
    const h = await createHarness({
      mailLimits: {
        perRecipient: { max: 2, windowMs: 3_600_000 },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 100, windowMs: 3_600_000 },
        global: { max: 1000, windowMs: 3_600_000 },
      },
    });
    const email = nextEmail();
    await signUp(h.app, email);
    for (let i = 0; i < 4; i++) {
      await h.app.inject({
        method: 'POST',
        url: '/api/auth/send-verification-email',
        headers: jsonHeaders,
        payload: { email, callbackURL: '/' },
      });
    }
    expect(h.outbox.filter((m) => m.to === email)).toHaveLength(2);
    await h.close();
  });

  it('limits mail-triggering requests per client IP and not across IPs', async () => {
    const h = await createHarness({
      mailLimits: {
        perRecipient: { max: 100, windowMs: 3_600_000 },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 3, windowMs: 3_600_000 },
        global: { max: 1000, windowMs: 3_600_000 },
      },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await signUp(h.app, nextEmail())).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);

    const elsewhere = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      remoteAddress: '127.0.0.1',
      headers: { ...jsonHeaders, 'x-forwarded-for': '203.0.113.9' },
      payload: { email: nextEmail(), password: PASSWORD, name: 'Other' },
    });
    expect(elsewhere.statusCode).toBe(200);
    await h.close();
  });

  it('counts mail-triggering sign-ins to unverified accounts against the per-IP budget', async () => {
    const h = await createHarness({
      mailLimits: {
        perRecipient: { max: 100, windowMs: 3_600_000 },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 2, windowMs: 3_600_000 },
        global: { max: 1000, windowMs: 3_600_000 },
      },
    });
    const emails = Array.from({ length: 6 }, () => nextEmail());
    for (const [i, email] of emails.entries()) {
      await signUp(h.app, email, { 'x-forwarded-for': `203.0.113.${i + 1}` });
    }
    h.outbox.length = 0;

    const statuses: number[] = [];
    for (const email of emails) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        remoteAddress: '127.0.0.1',
        headers: { ...jsonHeaders, 'x-forwarded-for': '198.51.100.9' },
        payload: { email, password: PASSWORD },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([403, 403, 403, 403, 403, 403]);
    expect(h.outbox).toHaveLength(2);

    const elsewhere = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: '127.0.0.1',
      headers: { ...jsonHeaders, 'x-forwarded-for': '198.51.100.10' },
      payload: { email: emails[0], password: PASSWORD },
    });
    expect(elsewhere.statusCode).toBe(403);
    expect(h.outbox).toHaveLength(3);
    await h.close();
  });

  it('does not charge the per-IP budget for sign-ins that send no mail', async () => {
    const h = await createHarness({
      mailLimits: {
        perRecipient: { max: 100, windowMs: 3_600_000 },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 2, windowMs: 3_600_000 },
        global: { max: 1000, windowMs: 3_600_000 },
      },
    });
    const { email } = await verifiedSession(h);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: jsonHeaders,
        payload: { email, password: PASSWORD },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 200]);
    await h.close();
  });

  it('shares one recipient budget across plus-tags and gmail dots', async () => {
    const h = await createHarness({
      mailLimits: {
        perRecipient: { max: 2, windowMs: 3_600_000 },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 100, windowMs: 3_600_000 },
        global: { max: 1000, windowMs: 3_600_000 },
      },
    });
    for (const email of ['v.ictim@gmail.com', 'victim+1@gmail.com', 'Victim+2@googlemail.com']) {
      await signUp(h.app, email);
    }
    expect(h.outbox.map((m) => m.to)).toEqual(['v.ictim@gmail.com', 'victim+1@gmail.com']);
    await h.close();
  });

  it('stops all mail at the global cap and logs it once', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    const h = await createHarness({
      mailLimits: {
        perRecipient: { max: 100, windowMs: 3_600_000 },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 100, windowMs: 3_600_000 },
        global: { max: 3, windowMs: 3_600_000 },
      },
    });
    for (let i = 0; i < 6; i++) {
      await signUp(h.app, nextEmail(), { 'x-forwarded-for': `203.0.113.${i + 1}` });
    }
    spy.mockRestore();
    expect(h.outbox).toHaveLength(3);
    expect(logs.filter((m) => m.includes('global mail cap'))).toHaveLength(1);
    await h.close();
  });

  it('keeps limiter state across a restart because it lives in Postgres', async () => {
    const h = await createHarness({
      mailLimits: {
        perRecipient: { max: 100, windowMs: 3_600_000 },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 100, windowMs: 3_600_000 },
        global: { max: 2, windowMs: 3_600_000 },
      },
    });
    await signUp(h.app, nextEmail());
    await signUp(h.app, nextEmail());
    const store = postgresHitStore(h.database, 'testsecrettestsecrettestsecret0123456789');
    expect(await store.consume('global', { max: 2, windowMs: 3_600_000 })).toBeGreaterThan(0);
    const rows = await h.database.pool.query('select key from mail_limit_hits');
    expect(rows.rows.every((r: { key: string }) => /^[0-9a-f]{64}$/.test(r.key))).toBe(true);
    await h.close();
  });

  it('refuses mail instead of sending it unmetered when the limiter store fails', async () => {
    const h = await createHarness();
    await h.database.pool.query('drop table mail_limit_hits');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await signUp(h.app, nextEmail());
    spy.mockRestore();
    expect(h.outbox).toHaveLength(0);
    await h.close();
  });

  it('ignores a spoofed x-forwarded-for from an untrusted peer', async () => {
    const h = await createHarness({
      mailLimits: {
        perRecipient: { max: 100, windowMs: 3_600_000 },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 2, windowMs: 3_600_000 },
        global: { max: 1000, windowMs: 3_600_000 },
      },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        remoteAddress: '198.51.100.7',
        headers: { ...jsonHeaders, 'x-forwarded-for': `203.0.113.${i}` },
        payload: { email: nextEmail(), password: PASSWORD, name: 'Spoof' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
    await h.close();
  });

  it('rate limits repeated sign-in attempts', async () => {
    const h = await createHarness({
      authLimits: {
        signIn: { window: 60, max: 3 },
        signUp: { window: 60, max: 100 },
        sendVerification: { window: 60, max: 100 },
        passwordReset: { window: 60, max: 100 },
      },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: jsonHeaders,
        payload: { email: 'nobody@bas.lu', password: 'whatever password' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(3)).toEqual([429, 429]);
    await h.close();
  });
});

describe('passkey plugin', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('issues authentication options for anonymous callers', async () => {
    const res = await h.app.inject('/api/auth/passkey/generate-authenticate-options');
    expect(res.statusCode).toBe(200);
    const options = res.json<{ challenge: string; rpId: string }>();
    expect(options.challenge.length).toBeGreaterThan(10);
    expect(options.rpId).toBe('fish.test');
  });

  it('requires a session to register a passkey', async () => {
    const anon = await h.app.inject('/api/auth/passkey/generate-register-options');
    expect(anon.statusCode).toBe(401);

    const { cookie } = await verifiedSession(h);
    const res = await h.app.inject({
      url: '/api/auth/passkey/generate-register-options',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ rp: { id: string } }>().rp.id).toBe('fish.test');
  });
});

describe('input and origin checks', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('rejects oversized names, unknown fields and bad JSON at sign-up without sending mail', async () => {
    const email = nextEmail();
    const bodies: object[] = [
      { email, password: PASSWORD, name: 'x'.repeat(9000) },
      { email, password: PASSWORD, name: 'ok', extra: 'field' },
      { email: 'not-an-email', password: PASSWORD, name: 'ok' },
    ];
    for (const payload of bodies) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: jsonHeaders,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(apiErrorSchema.parse(res.json()).error.code).toBe('validation_failed');
    }
    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: jsonHeaders,
      payload: '{nope',
    });
    expect(bad.statusCode).toBe(400);
    expect(h.outbox.filter((m) => m.to === email)).toHaveLength(0);
  });

  it('keeps the user-supplied name out of the verification mail', async () => {
    const email = nextEmail();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: jsonHeaders,
      payload: { email, password: PASSWORD, name: 'Visit http://phish.example now' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.outbox.find((m) => m.to === email)?.text).not.toContain('phish.example');
  });

  it('rejects a foreign Origin even under NODE_ENV=test', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      payload: { email: 'a@bas.lu', password: 'whatever password' },
    });
    expect(res.statusCode).toBe(403);
  });

  it.each(['https://evil.example/', '//evil.example/', '/\\evil.example'])(
    'rejects callbackURL %s',
    async (callbackURL) => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: jsonHeaders,
        payload: { email: nextEmail(), password: PASSWORD, name: 'Cb', callbackURL },
      });
      expect(res.statusCode).toBe(403);
    },
  );
});
