import { apiErrorSchema, sessionListSchema, userSchema } from '@aquarium/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

async function verifiedSession(h: Harness, email = nextEmail()) {
  await signUp(h.app, email);
  const verify = await h.app.inject(verificationPath(h, email));
  const cookie = cookieJar(verify);
  expect(cookie).not.toBe('');
  return { email, cookie, verify };
}

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
    expect(res.cookies).toHaveLength(0);
  });

  it('refuses sign-in until the email is verified, then allows it', async () => {
    const email = nextEmail();
    await signUp(h.app, email);
    const blocked = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: jsonHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.cookies).toHaveLength(0);

    await h.app.inject(verificationPath(h, email));
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

  it('ignores a spoofed x-forwarded-for from an untrusted peer', async () => {
    const h = await createHarness({
      mailLimits: {
        perRecipient: { max: 100, windowMs: 3_600_000 },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 2, windowMs: 3_600_000 },
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
