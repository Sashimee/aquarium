import { apiErrorSchema, sessionListSchema, userSchema } from '@aquarium/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMailer, DEFAULT_MAIL_LIMITS } from './mail.ts';
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

  const requestReset = async (email: string) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      headers: jsonHeaders,
      payload: { email, redirectTo: '/' },
    });
    await h.settleMail();
    return res;
  };

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

  it('keeps the session token out of every auth response body', async () => {
    const email = nextEmail();
    const signedUp = await signUp(h.app, email);
    const verify = await verifyFrom(h, email, signedUp);
    const cookie = cookieJar(verify);
    const sessionCookie = verify.cookies.find((c) => c.name.endsWith('session_token'));
    const token = decodeURIComponent(sessionCookie?.value ?? '').split('.')[0] ?? '';
    expect(token.length).toBeGreaterThan(10);

    const signedIn = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: jsonHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(signedIn.statusCode).toBe(200);
    const signInCookie = cookieJar(signedIn);
    const signInToken = decodeURIComponent(
      signedIn.cookies.find((c) => c.name.endsWith('session_token'))?.value ?? '',
    ).split('.')[0] as string;
    expect(signInToken.length).toBeGreaterThan(10);

    const got = await h.app.inject({ url: '/api/auth/get-session', headers: { cookie } });
    expect(got.statusCode).toBe(200);
    expect(got.json<{ user: { email: string } }>().user.email).toBe(email);

    const bodies = [signedUp.body, verify.body, signedIn.body, got.body];
    for (const body of bodies) {
      expect(body).not.toContain(token);
      expect(body).not.toContain(signInToken);
      expect(body).not.toContain('"token"');
    }
    const me = await h.app.inject({ url: '/api/me', headers: { cookie: signInCookie } });
    expect(me.statusCode).toBe(200);
  });

  it('does not expose revoke-session, which takes a token', async () => {
    const { cookie } = await verifiedSession(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/revoke-session',
      headers: { ...jsonHeaders, cookie },
      payload: { token: 'x' },
    });
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
  it('answers a resend inside the cooldown like any other, and still sends nothing', async () => {
    const h = await createHarness({
      mailLimits: {
        perRecipient: { max: 100, windowMs: 3_600_000 },
        verificationCooldown: { max: 1, windowMs: 60_000 },
        perIpSignup: { max: 100, windowMs: 3_600_000 },
        global: { max: 1000, windowMs: 3_600_000 },
      },
    });
    const cooled = nextEmail();
    await signUp(h.app, cooled);
    const unknown = nextEmail();
    const mailsBefore = h.outbox.length;

    const resend = async (email: string) => {
      const start = performance.now();
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/send-verification-email',
        headers: jsonHeaders,
        payload: { email, callbackURL: '/' },
      });
      await h.settleMail();
      return { res, ms: performance.now() - start };
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cooledRes = await resend(cooled);
    const logged = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    expect(logged).toEqual([expect.stringMatching(/^verification mail throttled, retry in \d+s$/)]);
    const unknownRes = await resend(unknown);
    expect(cooledRes.res.statusCode).toBe(200);
    expect(unknownRes.res.statusCode).toBe(200);
    expect(cooledRes.res.body).toBe(unknownRes.res.body);
    expect(cooledRes.res.headers['retry-after']).toBeUndefined();
    expect(h.outbox.length).toBe(mailsBefore);
    expect(h.outbox.filter((m) => m.to === cooled)).toHaveLength(1);

    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0;
    const cooledMs: number[] = [];
    const unknownMs: number[] = [];
    for (let i = 0; i < 3; i++) {
      cooledMs.push((await resend(cooled)).ms);
      unknownMs.push((await resend(nextEmail())).ms);
    }
    expect(Math.abs(median(cooledMs) - median(unknownMs))).toBeLessThan(150);
    expect(h.outbox.length).toBe(mailsBefore);
    await h.close();
  }, 20_000);

  it('does not make a resend wait on SMTP for a known address', async () => {
    const h = await createHarness();
    const email = nextEmail();
    await signUp(h.app, email);
    const held = h.holdMail();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/send-verification-email',
      headers: jsonHeaders,
      payload: { email, callbackURL: '/' },
    });
    expect(res.statusCode).toBe(200);
    const stranger = await h.app.inject({
      method: 'POST',
      url: '/api/auth/send-verification-email',
      headers: jsonHeaders,
      payload: { email: nextEmail(), callbackURL: '/' },
    });
    expect(res.body).toBe(stranger.body);
    await held.sendStarted;
    held.release();
    await h.settleMail();
    expect(h.outbox.filter((m) => m.to === email)).toHaveLength(2);
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
    const capLogs = logs.filter((m) => m.includes('mail_global_cap_reached'));
    expect(capLogs).toHaveLength(1);
    expect(JSON.parse(capLogs[0] ?? '')).toEqual({
      level: 'error',
      event: 'mail_global_cap_reached',
      msg: 'global mail cap reached',
      limit: 3,
      windowSeconds: 3600,
      retryAfterSeconds: expect.any(Number),
    });
    await h.close();
  });

  it('spends the global budget on a reset for an unknown address like on a known one (#199)', async () => {
    const attackerMailArrives = async (targetRegistered: boolean) => {
      const h = await createHarness({
        mailLimits: {
          perRecipient: { max: 100, windowMs: 3_600_000 },
          verificationCooldown: { max: 100, windowMs: 1000 },
          perIpSignup: { max: 100, windowMs: 3_600_000 },
          global: { max: 5, windowMs: 3_600_000 },
        },
      });
      try {
        const target = nextEmail();
        let spent = 0;
        if (targetRegistered) {
          await signUp(h.app, target);
          spent++;
        }
        for (; spent < 4; spent++) {
          await signUp(h.app, nextEmail(), { 'x-forwarded-for': `203.0.113.${spent + 1}` });
        }
        await h.app.inject({
          method: 'POST',
          url: '/api/auth/request-password-reset',
          headers: jsonHeaders,
          payload: { email: target, redirectTo: '/' },
        });
        await h.settleMail();
        const attacker = nextEmail();
        await signUp(h.app, attacker, { 'x-forwarded-for': '198.51.100.9' });
        await h.settleMail();
        return h.outbox.some((m) => m.to === attacker);
      } finally {
        await h.close();
      }
    };

    expect(await attackerMailArrives(true)).toBe(false);
    expect(await attackerMailArrives(false)).toBe(false);
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

  it('never exceeds the IP or global cap under concurrent requests at the boundary', async () => {
    const h = await createHarness();
    const limits = {
      perRecipient: { max: 100, windowMs: 3_600_000 },
      verificationCooldown: { max: 100, windowMs: 1000 },
      perIpSignup: { max: 5, windowMs: 3_600_000 },
      global: { max: 7, windowMs: 3_600_000 },
    };
    const sent: string[] = [];
    const transport = nodemailer.createTransport({ jsonTransport: true });
    transport.sendMail = (async (data: { to: string }) => {
      sent.push(data.to);
    }) as unknown as typeof transport.sendMail;
    const mailer = createMailer(transport, 'fish@bas.lu', {
      limits,
      store: postgresHitStore(h.database, 'concurrency-secret-concurrency-secret-01'),
      log: () => undefined,
    });
    const ipWaits = await Promise.all(
      Array.from({ length: 20 }, () => mailer.consumeIp('203.0.113.50')),
    );
    expect(ipWaits.filter((a) => a.wait === 0)).toHaveLength(5);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        mailer.sendVerification(`c${i}@bas.lu`, 'https://x.test/'),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(7);
    expect(sent).toHaveLength(7);
    await h.close();
  });

  it('charges no IP slot to concurrent requests while the global cap is spent', async () => {
    const h = await createHarness();
    const limits = {
      perRecipient: { max: 100, windowMs: 3_600_000 },
      verificationCooldown: { max: 100, windowMs: 1000 },
      perIpSignup: { max: 5, windowMs: 3_600_000 },
      global: { max: 1, windowMs: 3_600_000 },
    };
    const store = postgresHitStore(h.database, 'concurrency-secret-concurrency-secret-01');
    const transport = nodemailer.createTransport({ jsonTransport: true });
    transport.sendMail = (async () => undefined) as unknown as typeof transport.sendMail;
    const mailer = createMailer(transport, 'fish@bas.lu', { limits, store, log: () => undefined });
    await store.consume('global', limits.global);
    const spent = await Promise.all(
      Array.from({ length: 20 }, () => mailer.consumeIp('203.0.113.51')),
    );
    expect(spent.every((a) => a.wait === 0 && a.mailBlockedFor > 0)).toBe(true);
    expect(await store.remaining('ip:203.0.113.51', limits.perIpSignup)).toBe(0);
    const rows = await h.database.pool.query('select count(*)::int as n from mail_limit_hits');
    expect(rows.rows[0].n).toBe(1);
    await h.close();
  });

  describe('request admitted while the global cap is spent', () => {
    const limits = {
      perRecipient: { max: 100, windowMs: 3_600_000 },
      verificationCooldown: { max: 100, windowMs: 1000 },
      perIpSignup: { max: 100, windowMs: 3_600_000 },
      global: { max: 1000, windowMs: 3_600_000 },
    };

    async function harnessWithFlakyCap() {
      let spentOnce = false;
      const h = await createHarness({
        mailLimits: limits,
        wrapMailStore: (store) => ({
          consume: (key, limit) => store.consume(key, limit),
          remaining: async (key, limit) => {
            if (key === 'global' && spentOnce) {
              spentOnce = false;
              return 30;
            }
            return store.remaining(key, limit);
          },
        }),
      });
      const hits = async () =>
        Number(
          (await h.database.pool.query('select count(*)::int as n from mail_limit_hits')).rows[0].n,
        );
      return { h, hits, arm: () => (spentOnce = true) };
    }

    it('sends no sign-up mail and charges nothing when the cap frees before the mail step', async () => {
      const { h, hits, arm } = await harnessWithFlakyCap();
      const before = await hits();
      arm();
      expect((await signUp(h.app, nextEmail())).statusCode).toBe(200);
      await h.settleMail();
      expect(h.outbox).toHaveLength(0);
      expect(await hits()).toBe(before);
      await h.close();
    });

    it('sends no reset mail and charges nothing when the cap frees before the mail step', async () => {
      const { h, hits, arm } = await harnessWithFlakyCap();
      const email = nextEmail();
      await signUp(h.app, email);
      h.outbox.length = 0;
      const before = await hits();
      arm();
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/request-password-reset',
        headers: jsonHeaders,
        payload: { email, redirectTo: '/' },
      });
      expect(res.statusCode).toBe(200);
      await h.settleMail();
      expect(h.outbox).toHaveLength(0);
      expect(await hits()).toBe(before);
      await h.close();
    });
  });

  it('gives a known and an unknown address the same per-IP 429 sequence', async () => {
    const h = await createHarness({
      mailLimits: {
        perRecipient: { max: 1, windowMs: 3_600_000 },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 3, windowMs: 3_600_000 },
        global: { max: 1000, windowMs: 3_600_000 },
      },
    });
    const known = nextEmail();
    await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      remoteAddress: '127.0.0.1',
      headers: { ...jsonHeaders, 'x-forwarded-for': '203.0.113.1' },
      payload: { email: known, password: PASSWORD, name: 'Tester' },
    });
    const sequence = async (ip: string, url: string, email: string) => {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await h.app.inject({
          method: 'POST',
          url,
          remoteAddress: '127.0.0.1',
          headers: { ...jsonHeaders, 'x-forwarded-for': ip },
          payload: { email, callbackURL: '/', redirectTo: '/' },
        });
        statuses.push(res.statusCode);
      }
      return statuses;
    };
    for (const [n, url] of [
      '/api/auth/send-verification-email',
      '/api/auth/request-password-reset',
    ].entries()) {
      const forKnown = await sequence(`203.0.113.${10 + n}`, url, known);
      const forUnknown = await sequence(`203.0.113.${20 + n}`, url, nextEmail());
      expect(forKnown).toEqual([200, 200, 200, 429, 429]);
      expect(forUnknown).toEqual(forKnown);
    }
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

describe('auth proxy path rules cannot be dodged with dot segments (#199)', () => {
  const rawPost = (port: number, path: string, body: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path,
          headers: { ...jsonHeaders, 'content-length': Buffer.byteLength(body) },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  it.each([
    '/api/auth/x/%2E%2E/request-password-reset',
    '/api/auth/x/%2e%2e/request-password-reset',
    '/api/auth/./request-password-reset',
    '/api/auth/x/../request-password-reset',
    '/api/auth//request-password-reset',
    '/api/auth/x/%2E%2E/revoke-session',
    '/api/auth/x/%2E%2E/sign-up/email',
  ])('refuses %s', async (path) => {
    const h = await createHarness({
      mailLimits: { ...DEFAULT_MAIL_LIMITS, perIpSignup: { max: 1, windowMs: 60_000 } },
    });
    try {
      await h.app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = h.app.server.address() as AddressInfo;
      const body = JSON.stringify({ email: nextEmail(), redirectTo: '/' });
      expect(await rawPost(port, path, body)).toBe(404);
      expect(await rawPost(port, '/api/auth/request-password-reset', body)).toBe(200);
      expect(await rawPost(port, '/api/auth/request-password-reset', body)).toBe(429);
    } finally {
      await h.close();
    }
  });
});

describe('password reset request does not reveal the account (#161)', () => {
  const request = (h: Harness, email: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      headers: jsonHeaders,
      payload: { email, redirectTo: '/' },
    });

  const observable = (res: LightMyRequestResponse) => {
    const headers = { ...res.headers };
    delete headers['date'];
    delete headers['x-request-id'];
    return { status: res.statusCode, body: res.body, headers };
  };

  const resetMails = (h: Harness) => h.outbox.filter((m) => /reset/i.test(m.subject));

  it('answers identically for unknown, unverified, verified and throttled recipients', async () => {
    const h = await createHarness({
      mailLimits: { ...DEFAULT_MAIL_LIMITS, perIpSignup: { max: 10_000, windowMs: 60_000 } },
    });
    try {
      const unverified = nextEmail();
      await signUp(h.app, unverified);
      const verified = await verifiedSession(h);

      const unknown = observable(await request(h, nextEmail()));
      expect(unknown.status).toBe(200);
      expect(JSON.parse(unknown.body)).toMatchObject({ status: true });

      expect(observable(await request(h, unverified))).toEqual(unknown);
      expect(observable(await request(h, verified.email))).toEqual(unknown);
      await h.settleMail();
      expect(resetMails(h)).toHaveLength(2);

      expect(observable(await request(h, verified.email))).toEqual(unknown);
      await h.settleMail();
      expect(resetMails(h)).toHaveLength(2);
    } finally {
      await h.close();
    }
  });

  it('does not wait for the mail to be sent', async () => {
    const h = await createHarness();
    try {
      const { email } = await verifiedSession(h);
      const gate = h.holdMail();

      const res = await request(h, email);
      expect(res.statusCode).toBe(200);
      await gate.sendStarted;
      expect(resetMails(h)).toHaveLength(0);

      gate.release();
      await h.settleMail();
      expect(resetMails(h)).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('logs a failed send without the address or the token and still answers 200', async () => {
    const h = await createHarness();
    const printed: string[] = [];
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...a: unknown[]) => void printed.push(a.map(String).join(' ')));
    try {
      const { email } = await verifiedSession(h);
      const gate = h.holdMail();
      const res = await request(h, email);
      expect(res.statusCode).toBe(200);
      await gate.sendStarted;
      gate.fail(new Error(`smtp refused ${email} reset-password/secrettoken`));
      await h.settleMail();
      const output = printed.join('\n');
      expect(output).toContain('reset mail failed');
      expect(output).not.toContain(email);
      expect(output).not.toContain('secrettoken');
    } finally {
      spy.mockRestore();
      await h.close();
    }
  });
});
