import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import {
  apiErrorSchema,
  dataExportSchema,
  reminderSettingsSchema,
  tankSchema,
} from '@aquarium/shared';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.ts';
import { schema } from './db/index.ts';
import {
  isAllowedPushEndpoint,
  parseVapidKeys,
  vapidAuthorization,
  type PushResult,
  type PushSender,
} from './push.ts';
import {
  sweepReminders,
  unsubscribeToken,
  unsubscribeUrl,
  UNSUBSCRIBE_PATH,
  verifyUnsubscribeToken,
} from './reminders.ts';
import { APP_ORIGIN, createHarness, TEST_SECRET, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';
const KEYS = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close();
});

async function harness(push: PushSender | null = null): Promise<Harness> {
  const h = await createHarness({ push });
  harnesses.push(h);
  return h;
}

function pushStub(result: PushResult = 'sent') {
  const send = vi.fn<PushSender['send']>(async () => result);
  const sender: PushSender = { publicKey: 'PUBKEY', send };
  return { sender, send };
}

async function account(h: Harness) {
  const email = `t52-${Date.now()}-${counter++}@bas.lu`;
  const signedUp = await h.app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: jsonHeaders,
    payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/verify-email' },
  });
  const mail = h.outbox.findLast((m) => m.to === email);
  const link = /https?:\/\/\S+verify-email\?\S+/.exec(mail?.text ?? '')?.[0];
  if (!link) throw new Error('no verification link');
  const url = new URL(link);
  const cookie = cookieOf(
    await h.app.inject({
      method: 'GET',
      url: url.pathname + url.search,
      headers: { cookie: cookieOf(signedUp) },
    }),
  );
  const [user] = await h.database.db.select().from(schema.user).where(eq(schema.user.email, email));
  if (!user) throw new Error('user missing');
  return { email, cookie, userId: user.id };
}

const call = (
  h: Harness,
  cookie: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: object,
) =>
  h.app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie },
    ...(payload ? { payload } : {}),
  });

async function withFish(h: Harness, cookie: string) {
  const created = await call(h, cookie, 'POST', '/api/tanks', {
    name: 'Home',
    biome: 'freshwater',
  });
  const tank = tankSchema.parse(created.json());
  const fish = await call(h, cookie, 'POST', `/api/tanks/${tank.id}/fish`, {
    species: 'neon-tetra',
    name: 'Blip',
  });
  expect(fish.statusCode).toBe(201);
  return tank;
}

async function optedIn(h: Harness) {
  const a = await account(h);
  await withFish(h, a.cookie);
  const res = await call(h, a.cookie, 'PUT', '/api/me/reminders', { mail: true });
  expect(res.statusCode).toBe(200);
  return a;
}

const sweep = (h: Harness, push: PushSender | null = null, dailyCap = 100) =>
  sweepReminders({
    database: h.database,
    mailer: h.mailer,
    push,
    appOrigin: APP_ORIGIN,
    authSecret: TEST_SECRET,
    dailyCap,
    log: () => undefined,
  });

const reminderMails = (h: Harness, email: string) =>
  h.outbox.filter((m) => m.to === email && m.subject === 'Your fish are waiting');

const mailSetting = async (h: Harness, cookie: string) =>
  reminderSettingsSchema.parse((await call(h, cookie, 'GET', '/api/me/reminders')).json()).mail;

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);

describe('opt-in defaults', () => {
  it('starts with everything off and requires a session', async () => {
    const h = await harness();
    expect((await h.app.inject('/api/me/reminders')).statusCode).toBe(401);
    const a = await account(h);
    const res = await call(h, a.cookie, 'GET', '/api/me/reminders');
    expect(reminderSettingsSchema.parse(res.json())).toEqual({
      mail: false,
      push: false,
      pushAvailable: false,
      vapidPublicKey: null,
      subscriptions: 0,
    });
  });

  it('never mails a user who has not opted in', async () => {
    const h = await harness();
    const a = await account(h);
    await withFish(h, a.cookie);
    expect(await sweep(h)).toEqual({ sent: 0, capped: false });
    expect(reminderMails(h, a.email)).toHaveLength(0);
  });

  it('rejects an empty update and unknown fields', async () => {
    const h = await harness();
    const a = await account(h);
    expect((await call(h, a.cookie, 'PUT', '/api/me/reminders', {})).statusCode).toBe(400);
    expect(
      (await call(h, a.cookie, 'PUT', '/api/me/reminders', { mail: true, extra: 1 })).statusCode,
    ).toBe(400);
  });
});

describe('mail reminders', () => {
  it('mails an opted-in user whose fish are unfed, with one-click unsubscribe headers', async () => {
    const h = await harness();
    const a = await optedIn(h);
    expect((await sweep(h)).sent).toBe(1);
    const [mail] = reminderMails(h, a.email);
    const link = unsubscribeUrl(APP_ORIGIN, TEST_SECRET, a.userId);
    expect(mail?.headers['List-Unsubscribe']).toBe(`<${link}>`);
    expect(mail?.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail?.text).toContain(link);
  });

  it('skips a user who fed recently', async () => {
    const h = await harness();
    const a = await account(h);
    const tank = await withFish(h, a.cookie);
    await call(h, a.cookie, 'PUT', '/api/me/reminders', { mail: true });
    const fed = await call(h, a.cookie, 'POST', `/api/tanks/${tank.id}/care`, {
      type: 'feed',
      food: 'flakes',
      portion: 1,
    });
    expect(fed.statusCode).toBe(200);
    expect((await sweep(h)).sent).toBe(0);
  });
});

describe('daily caps', () => {
  it('sends a user at most one reminder per day', async () => {
    const h = await harness();
    const a = await optedIn(h);
    expect((await sweep(h)).sent).toBe(1);
    expect((await sweep(h)).sent).toBe(0);
    expect(reminderMails(h, a.email)).toHaveLength(1);

    await h.database.db
      .update(schema.reminderPrefs)
      .set({ lastSentAt: ago(25) })
      .where(eq(schema.reminderPrefs.userId, a.userId));
    expect((await sweep(h)).sent).toBe(1);
    expect(reminderMails(h, a.email)).toHaveLength(2);
  });

  it('stops at the global daily cap and resumes once the window passes', async () => {
    const h = await harness();
    const users = [await optedIn(h), await optedIn(h), await optedIn(h)];
    expect(await sweep(h, null, 2)).toEqual({ sent: 2, capped: true });
    expect(await sweep(h, null, 2)).toEqual({ sent: 0, capped: true });
    expect(users.filter((u) => reminderMails(h, u.email).length > 0)).toHaveLength(2);

    await h.database.db.update(schema.reminderPrefs).set({ lastSentAt: ago(25) });
    expect((await sweep(h, null, 2)).sent).toBe(2);
  });

  it('sends nothing with a cap of zero', async () => {
    const h = await harness();
    const a = await optedIn(h);
    expect(await sweep(h, null, 0)).toEqual({ sent: 0, capped: true });
    expect(reminderMails(h, a.email)).toHaveLength(0);
  });
});

describe('mail budget', () => {
  it('keeps verification mail flowing while reminders run at their cap', async () => {
    const window = 60 * 60_000;
    const h = await createHarness({
      mailLimits: {
        perRecipient: { max: 100, windowMs: window },
        verificationCooldown: { max: 100, windowMs: 1000 },
        perIpSignup: { max: 100, windowMs: window },
        global: { max: 4, windowMs: window },
      },
    });
    harnesses.push(h);
    const users = [await optedIn(h), await optedIn(h), await optedIn(h)];
    expect(await sweep(h, null, 3)).toEqual({ sent: 3, capped: true });
    expect(users.every((u) => reminderMails(h, u.email).length === 1)).toBe(true);
    const next = await account(h);
    expect(h.outbox.some((m) => m.to === next.email)).toBe(true);
  });

  it('holds the global cap across overlapping sweeps', async () => {
    const h = await harness();
    for (let i = 0; i < 5; i++) await optedIn(h);
    const results = await Promise.all([sweep(h, null, 2), sweep(h, null, 2), sweep(h, null, 2)]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(2);
    const rows = await h.database.db.select().from(schema.reminderPrefs);
    expect(rows.filter((r) => r.lastSentAt !== null)).toHaveLength(2);
  });

  it('stops claiming once asked to stop', async () => {
    const h = await harness();
    await optedIn(h);
    const result = await sweepReminders({
      database: h.database,
      mailer: h.mailer,
      push: null,
      appOrigin: APP_ORIGIN,
      authSecret: TEST_SECRET,
      dailyCap: 10,
      shouldStop: () => true,
    });
    expect(result.sent).toBe(0);
    const rows = await h.database.db.select().from(schema.reminderPrefs);
    expect(rows.every((r) => r.lastSentAt === null)).toBe(true);
  });
});

describe('unsubscribe', () => {
  const urlFor = (token: string) => `${UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`;

  it('signs tokens that only verify under the same secret and userId', () => {
    const token = unsubscribeToken(TEST_SECRET, 'user-1');
    expect(verifyUnsubscribeToken(TEST_SECRET, token)).toBe('user-1');
    expect(verifyUnsubscribeToken('another-secret-another-secret-00', token)).toBeNull();
    expect(verifyUnsubscribeToken(TEST_SECRET, token.replace('user-1', 'user-2'))).toBeNull();
    expect(verifyUnsubscribeToken(TEST_SECRET, `${token}x`)).toBeNull();
    expect(verifyUnsubscribeToken(TEST_SECRET, 'nodot')).toBeNull();
    expect(verifyUnsubscribeToken(TEST_SECRET, '.sig')).toBeNull();
  });

  it('one-click POST without a session turns mail off, and replaying it is harmless', async () => {
    const h = await harness();
    const a = await optedIn(h);
    const url = urlFor(unsubscribeToken(TEST_SECRET, a.userId));

    for (let i = 0; i < 2; i++) {
      const res = await h.app.inject({
        method: 'POST',
        url,
        headers: formHeaders,
        payload: 'List-Unsubscribe=One-Click',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    }
    expect(await mailSetting(h, a.cookie)).toBe(false);
    expect((await sweep(h)).sent).toBe(0);
  });

  it('a replayed link does not undo a later opt-in beyond switching mail off again', async () => {
    const h = await harness();
    const a = await optedIn(h);
    const url = urlFor(unsubscribeToken(TEST_SECRET, a.userId));
    await h.app.inject({ method: 'POST', url, headers: formHeaders, payload: 'x=1' });
    await call(h, a.cookie, 'PUT', '/api/me/reminders', { mail: true });
    expect(await mailSetting(h, a.cookie)).toBe(true);
    await h.app.inject({ method: 'POST', url, headers: formHeaders, payload: 'x=1' });
    expect(await mailSetting(h, a.cookie)).toBe(false);
  });

  it('GET shows a confirmation page and changes nothing', async () => {
    const h = await harness();
    const a = await optedIn(h);
    const res = await h.app.inject(urlFor(unsubscribeToken(TEST_SECRET, a.userId)));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<form method="post"');
    expect(await mailSetting(h, a.cookie)).toBe(true);
  });

  it('rejects missing, forged and tampered tokens and leaves the setting on', async () => {
    const h = await harness();
    const a = await optedIn(h);
    const good = unsubscribeToken(TEST_SECRET, a.userId);
    const forged = unsubscribeToken('x'.repeat(40), a.userId);
    for (const token of [undefined, '', 'garbage', forged, `${good}A`, `${a.userId}.`]) {
      const url = token === undefined ? UNSUBSCRIBE_PATH : urlFor(token);
      for (const method of ['GET', 'POST'] as const) {
        const res = await h.app.inject({
          method,
          url,
          ...(method === 'POST'
            ? { headers: formHeaders, payload: 'List-Unsubscribe=One-Click' }
            : {}),
        });
        expect(res.statusCode).toBe(400);
        expect(apiErrorSchema.parse(res.json()).error.code).toBe('validation_failed');
      }
    }
    expect(await mailSetting(h, a.cookie)).toBe(true);
  });

  it('accepts the RFC 8058 body as multipart/form-data too', async () => {
    const h = await harness();
    const a = await optedIn(h);
    const boundary = 'xBOUNDARYx';
    const res = await h.app.inject({
      method: 'POST',
      url: urlFor(unsubscribeToken(TEST_SECRET, a.userId)),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--${boundary}--\r\n`,
    });
    expect(res.statusCode).toBe(200);
    expect(await mailSetting(h, a.cookie)).toBe(false);
  });

  it('lets the confirm page post with Origin: null while signed in, but only on this path', async () => {
    const h = await harness();
    const a = await optedIn(h);
    const res = await h.app.inject({
      method: 'POST',
      url: urlFor(unsubscribeToken(TEST_SECRET, a.userId)),
      headers: { ...formHeaders, origin: 'null', cookie: a.cookie },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(await mailSetting(h, a.cookie)).toBe(false);

    const other = await h.app.inject({
      method: 'PUT',
      url: '/api/me/reminders',
      headers: { 'content-type': 'application/json', origin: 'null', cookie: a.cookie },
      payload: { mail: true },
    });
    expect(other.statusCode).toBe(403);
  });

  it('throttles per token, and invalid tokens per IP, so a shared provider IP still works', async () => {
    const window = 60_000;
    const h = await createHarness({
      reminderLimits: {
        write: { max: 1000, windowMs: window },
        unsubscribe: { max: 2, windowMs: window },
        invalidUnsubscribe: { max: 2, windowMs: window },
      },
    });
    harnesses.push(h);
    const post = (token: string) =>
      h.app.inject({ method: 'POST', url: urlFor(token), headers: formHeaders, payload: 'x=1' });
    const first = unsubscribeToken(TEST_SECRET, 'user-a');
    expect([200, 200, 429]).toEqual([
      (await post(first)).statusCode,
      (await post(first)).statusCode,
      (await post(first)).statusCode,
    ]);
    expect((await post(unsubscribeToken(TEST_SECRET, 'user-b'))).statusCode).toBe(200);
    expect([400, 400, 429]).toEqual([
      (await post('bad')).statusCode,
      (await post('bad')).statusCode,
      (await post('bad')).statusCode,
    ]);
    expect((await post(unsubscribeToken(TEST_SECRET, 'user-c'))).statusCode).toBe(200);
  });

  it('does not accept form bodies on other routes', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/me/reminders',
      headers: { ...formHeaders, origin: APP_ORIGIN },
      payload: 'mail=true',
    });
    expect(res.statusCode).toBe(415);
  });

  it('keeps the token out of the logs', async () => {
    const lines: string[] = [];
    const h = await createHarness({ logStream: { write: (chunk) => void lines.push(chunk) } });
    harnesses.push(h);
    const token = unsubscribeToken(TEST_SECRET, 'user-log');
    await h.app.inject({
      method: 'POST',
      url: `${UNSUBSCRIBE_PATH}?token=${token}`,
      headers: formHeaders,
      payload: 'x=1',
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).not.toContain(token);
  });
});

describe('web push', () => {
  it('is cleanly unavailable without VAPID: settings say so, push cannot be enabled, mail works', async () => {
    const h = await harness(null);
    const a = await optedIn(h);
    const settings = reminderSettingsSchema.parse(
      (await call(h, a.cookie, 'GET', '/api/me/reminders')).json(),
    );
    expect(settings).toMatchObject({ pushAvailable: false, vapidPublicKey: null });
    const on = await call(h, a.cookie, 'PUT', '/api/me/reminders', { push: true });
    expect(on.statusCode).toBe(409);
    expect((await sweep(h)).sent).toBe(1);
    expect(reminderMails(h, a.email)).toHaveLength(1);
  });

  it('does not push to a stored subscription while push is disabled', async () => {
    const h = await harness(null);
    const a = await account(h);
    await withFish(h, a.cookie);
    await h.database.db
      .insert(schema.reminderPrefs)
      .values({ userId: a.userId, mailEnabled: false, pushEnabled: true });
    await h.database.db
      .insert(schema.pushSubscriptions)
      .values({ userId: a.userId, endpoint: ENDPOINT, p256dh: KEYS.p256dh, auth: KEYS.auth });
    expect((await sweep(h, null)).sent).toBe(0);
  });

  it('loadConfig leaves push off without VAPID and rejects half or broken keys', () => {
    const base = {
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      BETTER_AUTH_SECRET: 'a'.repeat(40),
      APP_URL: 'https://fish.bas.lu',
    };
    expect(loadConfig(base).vapid).toBeNull();
    expect(() => loadConfig({ ...base, VAPID_PUBLIC_KEY: 'abc' })).toThrow(/together/);
    expect(() => loadConfig({ ...base, VAPID_PRIVATE_KEY: 'abc' })).toThrow(/together/);
    expect(() =>
      loadConfig({ ...base, VAPID_PUBLIC_KEY: 'abc', VAPID_PRIVATE_KEY: 'def' }),
    ).toThrow(/VAPID keys invalid/);
    expect(() => loadConfig({ ...base, VAPID_SUBJECT: 'ftp://x' })).toThrow(/VAPID_SUBJECT/);
  });

  it('parses a valid key pair and refuses a mismatched one', () => {
    const make = () => {
      const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
        format: 'jwk',
      });
      const pub = Buffer.concat([
        Buffer.from([4]),
        Buffer.from(jwk.x ?? '', 'base64url'),
        Buffer.from(jwk.y ?? '', 'base64url'),
      ]).toString('base64url');
      return { pub, priv: jwk.d ?? '' };
    };
    const one = make();
    const two = make();
    expect(parseVapidKeys(one.pub, one.priv).publicKey).toBe(one.pub);
    expect(() => parseVapidKeys(one.pub, two.priv)).toThrow(/does not belong/);

    const header = vapidAuthorization(
      parseVapidKeys(one.pub, one.priv),
      'mailto:fish@bas.lu',
      'https://fcm.googleapis.com',
      0,
    );
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
    const [head, body, sig] = (jwt ?? '').split('.');
    const verified = verify(
      'sha256',
      Buffer.from(`${head}.${body}`),
      {
        key: createPublicKey(parseVapidKeys(one.pub, one.priv).privateKey),
        dsaEncoding: 'ieee-p1363',
      },
      Buffer.from(sig ?? '', 'base64url'),
    );
    expect(verified).toBe(true);
    expect(k).toBe(one.pub);
  });

  it('allows only browser push services as endpoints', () => {
    expect(isAllowedPushEndpoint(ENDPOINT)).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(
      true,
    );
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://evil.example/fcm.googleapis.com')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.example/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://127.0.0.1/x')).toBe(false);
  });

  it('registers a subscription, pushes, and drops a gone endpoint', async () => {
    const { sender, send } = pushStub('sent');
    const h = await harness(sender);
    const a = await account(h);
    await withFish(h, a.cookie);
    const sub = await call(h, a.cookie, 'POST', '/api/me/push-subscriptions', {
      endpoint: ENDPOINT,
      keys: KEYS,
    });
    expect(sub.statusCode).toBe(204);
    const on = await call(h, a.cookie, 'PUT', '/api/me/reminders', { push: true });
    expect(reminderSettingsSchema.parse(on.json())).toMatchObject({
      push: true,
      mail: false,
      pushAvailable: true,
      vapidPublicKey: 'PUBKEY',
      subscriptions: 1,
    });
    expect((await sweep(h, sender)).sent).toBe(1);
    expect(send).toHaveBeenCalledWith(ENDPOINT);

    const gone = pushStub('gone');
    await h.database.db
      .update(schema.reminderPrefs)
      .set({ lastSentAt: null })
      .where(eq(schema.reminderPrefs.userId, a.userId));
    expect((await sweep(h, gone.sender)).sent).toBe(0);
    const settings = await call(h, a.cookie, 'GET', '/api/me/reminders');
    expect(reminderSettingsSchema.parse(settings.json()).subscriptions).toBe(0);
  });

  it('does not let another account take over a registered device', async () => {
    const { sender } = pushStub();
    const h = await harness(sender);
    const a = await account(h);
    const b = await account(h);
    const body = { endpoint: ENDPOINT, keys: KEYS };
    expect((await call(h, a.cookie, 'POST', '/api/me/push-subscriptions', body)).statusCode).toBe(
      204,
    );
    const taken = await call(h, b.cookie, 'POST', '/api/me/push-subscriptions', {
      endpoint: ENDPOINT,
      keys: { p256dh: 'C'.repeat(87), auth: 'b'.repeat(22) },
    });
    expect(taken.statusCode).toBe(409);
    expect((await call(h, a.cookie, 'POST', '/api/me/push-subscriptions', body)).statusCode).toBe(
      204,
    );
    const rows = await h.database.db.select().from(schema.pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: a.userId, p256dh: KEYS.p256dh });
  });

  it('rejects an endpoint on a non-push host and a malformed key', async () => {
    const { sender } = pushStub();
    const h = await harness(sender);
    const a = await account(h);
    const evil = await call(h, a.cookie, 'POST', '/api/me/push-subscriptions', {
      endpoint: 'https://internal.example/hook',
      keys: KEYS,
    });
    expect(evil.statusCode).toBe(400);
    const bad = await call(h, a.cookie, 'POST', '/api/me/push-subscriptions', {
      endpoint: ENDPOINT,
      keys: { p256dh: 'short', auth: KEYS.auth },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('export and deletion', () => {
  it('exports reminder settings and subscriptions, and deletes them with the account', async () => {
    const { sender } = pushStub();
    const h = await harness(sender);
    const a = await optedIn(h);
    await call(h, a.cookie, 'POST', '/api/me/push-subscriptions', {
      endpoint: ENDPOINT,
      keys: KEYS,
    });
    await call(h, a.cookie, 'PUT', '/api/me/reminders', { push: true });
    await sweep(h, sender);

    const exported = dataExportSchema.parse(
      (await call(h, a.cookie, 'POST', '/api/me/export')).json(),
    );
    expect(exported.reminders).toMatchObject({ mail: true, push: true });
    expect(exported.reminders.lastSentAt).not.toBeNull();
    expect(exported.reminders.pushSubscriptions).toHaveLength(1);
    expect(exported.reminders.pushSubscriptions[0]?.endpoint).toBe(ENDPOINT);

    const del = await call(h, a.cookie, 'POST', '/api/me/delete', { password: PASSWORD });
    expect(del.statusCode).toBeLessThan(300);
    const { db } = h.database;
    expect(
      await db.select().from(schema.reminderPrefs).where(eq(schema.reminderPrefs.userId, a.userId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.userId, a.userId)),
    ).toHaveLength(0);
  });

  it('exports defaults for a user who never opted in', async () => {
    const h = await harness();
    const a = await account(h);
    const exported = dataExportSchema.parse(
      (await call(h, a.cookie, 'POST', '/api/me/export')).json(),
    );
    expect(exported.reminders).toEqual({
      mail: false,
      push: false,
      lastSentAt: null,
      pushSubscriptions: [],
    });
  });
});
