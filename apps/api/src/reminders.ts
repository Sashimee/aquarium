import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  idSchema,
  MAX_PUSH_SUBSCRIPTIONS,
  pushDeviceListSchema,
  pushDeviceQuerySchema,
  removePushResultSchema,
  pushSubscriptionRequestSchema,
  REMINDER_AFTER_UNFED_HOURS,
  REMINDER_COOLDOWN_HOURS,
  reminderSettingsSchema,
  removePushSubscriptionRequestSchema,
  updateReminderSettingsRequestSchema,
} from '@aquarium/shared';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { schema, type Database } from './db/index.ts';
import { apiError } from './errors.ts';
import { MailThrottledError, type Mailer } from './mail.ts';
import { isAllowedPushEndpoint, type PushSender } from './push.ts';
import type { Limit, RateLimiter } from './rate-limit.ts';

const deviceParamsSchema = z.object({ id: idSchema });

export const UNSUBSCRIBE_PATH = '/api/reminders/unsubscribe';

export interface ReminderLimits {
  write: Limit;
  /** Per signed token, so mail providers behind a shared IP are not throttled together. */
  unsubscribe: Limit;
  /** Per IP, only for requests whose token does not verify. */
  invalidUnsubscribe: Limit;
}

export const DEFAULT_REMINDER_LIMITS: ReminderLimits = {
  write: { max: 30, windowMs: 15 * 60_000 },
  unsubscribe: { max: 30, windowMs: 60 * 60_000 },
  invalidUnsubscribe: { max: 60, windowMs: 60 * 60_000 },
};

const safeEqual = (x: string, y: string) => {
  const bx = Buffer.from(x);
  const by = Buffer.from(y);
  return bx.length === by.length && timingSafeEqual(bx, by);
};

const sameKeys = (row: { p256dh: string; auth: string }, keys: { p256dh: string; auth: string }) =>
  safeEqual(row.p256dh, keys.p256dh) && safeEqual(row.auth, keys.auth);

const signature = (secret: string, userId: string) =>
  createHmac('sha256', `${secret}:reminder-unsubscribe`).update(userId).digest('base64url');

export function unsubscribeToken(secret: string, userId: string): string {
  return `${userId}.${signature(secret, userId)}`;
}

export function verifyUnsubscribeToken(secret: string, token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const userId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(signature(secret, userId));
  return given.length === expected.length && timingSafeEqual(given, expected) ? userId : null;
}

export function unsubscribeUrl(appOrigin: string, secret: string, userId: string): string {
  return `${appOrigin}${UNSUBSCRIBE_PATH}?token=${encodeURIComponent(unsubscribeToken(secret, userId))}`;
}

interface ReminderUser {
  id: string;
  emailVerified: boolean;
}

export interface ReminderRouteDeps {
  app: FastifyInstance;
  database: Database;
  push: PushSender | null;
  authSecret: string;
  limiter: RateLimiter;
  limits: ReminderLimits;
  currentUser: (req: FastifyRequest) => Promise<ReminderUser | null>;
}

const CONFIRM_PAGE = (action: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Stop reminders</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:48px auto;padding:0 16px">
<h1 style="font-size:20px">Stop care reminder emails?</h1>
<form method="post" action="${action}"><button type="submit" style="font-size:16px;padding:12px 24px">Stop reminders</button></form>
</body></html>`;

const DONE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Reminders stopped</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:48px auto;padding:0 16px">
<h1 style="font-size:20px">Reminder emails stopped</h1><p>You will not get more care reminder emails.</p>
</body></html>`;

export function registerReminderRoutes(deps: ReminderRouteDeps): void {
  const { app, database, push, authSecret, limiter, limits } = deps;
  const { db } = database;

  const authed = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await deps.currentUser(req);
    if (!user) {
      reply.code(401).send(apiError('unauthenticated', 'Sign in required.'));
      return null;
    }
    const wait = req.method === 'GET' ? 0 : limiter.consume(`reminders:${user.id}`, limits.write);
    if (wait > 0) {
      reply
        .code(429)
        .header('retry-after', String(wait))
        .send(apiError('rate_limited', 'Too many requests. Try again later.'));
      return null;
    }
    return user;
  };

  const settings = async (userId: string) => {
    const [prefs] = await db
      .select()
      .from(schema.reminderPrefs)
      .where(eq(schema.reminderPrefs.userId, userId));
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.userId, userId));
    return reminderSettingsSchema.parse({
      mail: prefs?.mailEnabled ?? false,
      push: prefs?.pushEnabled ?? false,
      pushAvailable: push !== null,
      vapidPublicKey: push?.publicKey ?? null,
      subscriptions: count,
    });
  };

  app.get('/api/me/reminders', async (req, reply) => {
    const user = await authed(req, reply);
    if (!user) return reply;
    reply.header('cache-control', 'no-store');
    return settings(user.id);
  });

  app.put('/api/me/reminders', async (req, reply) => {
    const user = await authed(req, reply);
    if (!user) return reply;
    const { mail, push: pushOn } = updateReminderSettingsRequestSchema.parse(req.body);
    if (mail === true && !user.emailVerified) {
      return reply
        .code(403)
        .send(apiError('email_not_verified', 'Verify your email address before turning on mail.'));
    }
    if (pushOn === true && push === null) {
      return reply
        .code(409)
        .send(apiError('conflict', 'Push reminders are not available on this server.'));
    }
    await db
      .insert(schema.reminderPrefs)
      .values({ userId: user.id, mailEnabled: mail ?? false, pushEnabled: pushOn ?? false })
      .onConflictDoUpdate({
        target: schema.reminderPrefs.userId,
        set: {
          ...(mail !== undefined ? { mailEnabled: mail } : {}),
          ...(pushOn !== undefined ? { pushEnabled: pushOn } : {}),
        },
      });
    reply.header('cache-control', 'no-store');
    return settings(user.id);
  });

  app.post('/api/me/push-subscriptions', async (req, reply) => {
    const user = await authed(req, reply);
    if (!user) return reply;
    const { endpoint, keys } = pushSubscriptionRequestSchema.parse(req.body);
    if (!isAllowedPushEndpoint(endpoint)) {
      return reply
        .code(400)
        .send(
          apiError('validation_failed', 'Endpoint is not a supported browser push service.', [
            { path: ['endpoint'], message: 'Unsupported push service.' },
          ]),
        );
    }
    const stored = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`push-endpoint:${endpoint}`}, 0))`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`push:${user.id}`}, 0))`,
      );
      const [row] = await tx
        .select()
        .from(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.endpoint, endpoint));
      if (row && row.userId !== user.id && !sameKeys(row, keys)) {
        return 'taken' as const;
      }
      if (!row || row.userId !== user.id) {
        const [{ count } = { count: 0 }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.pushSubscriptions)
          .where(eq(schema.pushSubscriptions.userId, user.id));
        if (count >= MAX_PUSH_SUBSCRIPTIONS) return 'limit' as const;
      }
      // The row can be deleted between the read and here (device removal, a gone push, account
      // deletion do not take these locks), so a missed update falls through to an insert.
      const handover = row !== undefined && row.userId !== user.id;
      const updated = row
        ? await tx
            .update(schema.pushSubscriptions)
            .set({
              userId: user.id,
              p256dh: keys.p256dh,
              auth: keys.auth,
              ...(handover ? { createdAt: sql`now()`, lastUsedAt: null } : {}),
            })
            .where(eq(schema.pushSubscriptions.id, row.id))
            .returning({ id: schema.pushSubscriptions.id })
        : [];
      if (updated.length === 0) {
        await tx
          .insert(schema.pushSubscriptions)
          .values({ userId: user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth });
      }
      return 'ok' as const;
    });
    if (stored === 'taken') {
      return reply
        .code(409)
        .send(
          apiError('push_device_owned', 'This device is already registered to another account.'),
        );
    }
    if (stored === 'limit') {
      return reply
        .code(409)
        .send(
          apiError(
            'push_device_limit',
            `At most ${MAX_PUSH_SUBSCRIPTIONS} devices can get push. Remove one first.`,
          ),
        );
    }
    return reply.code(204).send();
  });

  app.get('/api/me/push-subscriptions', async (req, reply) => {
    const user = await authed(req, reply);
    if (!user) return reply;
    const { endpoint: mine } = pushDeviceQuerySchema.parse(req.query);
    const rows = await db
      .select({
        id: schema.pushSubscriptions.id,
        endpoint: schema.pushSubscriptions.endpoint,
        createdAt: schema.pushSubscriptions.createdAt,
        lastUsedAt: schema.pushSubscriptions.lastUsedAt,
      })
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.userId, user.id))
      .orderBy(asc(schema.pushSubscriptions.createdAt));
    reply.header('cache-control', 'no-store');
    return pushDeviceListSchema.parse({
      devices: rows.map(({ endpoint, ...rest }) => ({
        id: rest.id,
        createdAt: rest.createdAt.toISOString(),
        lastUsedAt: rest.lastUsedAt?.toISOString() ?? null,
        label: new URL(endpoint).hostname,
        current: endpoint === mine,
      })),
    });
  });

  app.delete('/api/me/push-subscriptions/:id', async (req, reply) => {
    const user = await authed(req, reply);
    if (!user) return reply;
    const id = deviceParamsSchema.safeParse(req.params);
    const removed = id.success
      ? await db
          .delete(schema.pushSubscriptions)
          .where(
            and(
              eq(schema.pushSubscriptions.id, id.data.id),
              eq(schema.pushSubscriptions.userId, user.id),
            ),
          )
          .returning({ id: schema.pushSubscriptions.id })
      : [];
    return removePushResultSchema.parse({ removed: removed.length > 0 });
  });

  app.post('/api/me/push-subscriptions/remove', async (req, reply) => {
    const user = await authed(req, reply);
    if (!user) return reply;
    const { endpoint } = removePushSubscriptionRequestSchema.parse(req.body);
    const removed = await db
      .delete(schema.pushSubscriptions)
      .where(
        and(
          eq(schema.pushSubscriptions.userId, user.id),
          eq(schema.pushSubscriptions.endpoint, endpoint),
        ),
      )
      .returning({ id: schema.pushSubscriptions.id });
    return removePushResultSchema.parse({ removed: removed.length > 0 });
  });

  const tokenOf = (req: FastifyRequest): string | null => {
    const token = (req.query as { token?: unknown }).token;
    return typeof token === 'string' && token.length <= 200 ? token : null;
  };

  app.get(UNSUBSCRIBE_PATH, async (req, reply) => {
    const token = tokenOf(req);
    if (!token || !verifyUnsubscribeToken(authSecret, token)) {
      return reply.code(400).send(apiError('validation_failed', 'Invalid unsubscribe link.'));
    }
    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(CONFIRM_PAGE(`${UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`));
  });

  // RFC 8058: the mail provider POSTs `List-Unsubscribe=One-Click` with no cookies, so the signed
  // token is the only credential.
  app.post(UNSUBSCRIBE_PATH, async (req, reply) => {
    const token = tokenOf(req);
    const userId = token ? verifyUnsubscribeToken(authSecret, token) : null;
    const wait = userId
      ? limiter.consume(`unsubscribe:${userId}`, limits.unsubscribe)
      : limiter.consume(`unsubscribe-invalid:${req.ip}`, limits.invalidUnsubscribe);
    if (wait > 0) {
      return reply
        .code(429)
        .header('retry-after', String(wait))
        .send(apiError('rate_limited', 'Too many requests. Try again later.'));
    }
    if (!userId) {
      return reply.code(400).send(apiError('validation_failed', 'Invalid unsubscribe link.'));
    }
    await db
      .update(schema.reminderPrefs)
      .set({ mailEnabled: false })
      .where(eq(schema.reminderPrefs.userId, userId));
    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(DONE_PAGE);
  });
}

export interface ReminderSweepDeps {
  database: Database;
  mailer: Mailer;
  push: PushSender | null;
  appOrigin: string;
  authSecret: string;
  dailyCap: number;
  batch?: number;
  shouldStop?: () => boolean;
  inflight?: InflightClaims;
  log?: (message: string) => void;
}

interface Candidate extends Record<string, unknown> {
  user_id: string;
  email: string;
  mail_enabled: boolean;
  push_enabled: boolean;
  last_sent_at: Date | null;
}

export interface InflightClaim {
  previous: Date | null;
  delivered: boolean;
}

export type InflightClaims = Map<string, InflightClaim>;

export async function releaseInflightClaims(
  database: Database,
  inflight: InflightClaims,
): Promise<number> {
  const unsent = [...inflight].filter(([, claim]) => !claim.delivered);
  for (const [userId, claim] of unsent) {
    await database.db
      .update(schema.reminderPrefs)
      .set({ lastSentAt: claim.previous })
      .where(eq(schema.reminderPrefs.userId, userId));
    inflight.delete(userId);
  }
  return unsent.length;
}

type Claim = 'claimed' | 'lost' | 'capped';

// The lock serialises the count and the update, so overlapping sweeps cannot overshoot the cap.
async function claimReminder(db: Database['db'], userId: string, dailyCap: number): Promise<Claim> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('reminder-daily-cap', 0))`);
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.reminderPrefs)
      .where(
        sql`${schema.reminderPrefs.lastSentAt} > now() - make_interval(hours => ${REMINDER_COOLDOWN_HOURS})`,
      );
    if (count >= dailyCap) return 'capped';
    const claimed = await tx
      .update(schema.reminderPrefs)
      .set({ lastSentAt: sql`now()` })
      .where(
        and(
          eq(schema.reminderPrefs.userId, userId),
          sql`(${schema.reminderPrefs.lastSentAt} is null or ${schema.reminderPrefs.lastSentAt} <= now() - make_interval(hours => ${REMINDER_COOLDOWN_HOURS}))`,
        ),
      )
      .returning({ userId: schema.reminderPrefs.userId });
    return claimed.length === 0 ? 'lost' : 'claimed';
  });
}

export interface ReminderSweepResult {
  sent: number;
  capped: boolean;
}

// Mail goes out one by one at 10-minute sweeps, so the relay never sees more than ~120 reminders an hour.
const DEFAULT_SWEEP_BATCH = 20;

export async function sweepReminders(deps: ReminderSweepDeps): Promise<ReminderSweepResult> {
  const { database, mailer, push, appOrigin, authSecret, log = console.error } = deps;
  const { db } = database;

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.reminderPrefs)
    .where(
      sql`${schema.reminderPrefs.lastSentAt} > now() - make_interval(hours => ${REMINDER_COOLDOWN_HOURS})`,
    );
  let remaining = deps.dailyCap - count;
  if (remaining <= 0) return { sent: 0, capped: true };

  const pushWanted = push !== null;
  const { rows } = await db.execute<Candidate>(sql`
    select p.user_id, u.email, p.mail_enabled, p.push_enabled, p.last_sent_at
    from reminder_prefs p
    join "user" u on u.id = p.user_id
    where u.email_verified
      and (p.mail_enabled or (${pushWanted} and p.push_enabled and exists (
        select 1 from push_subscriptions s where s.user_id = p.user_id)))
      and (p.last_sent_at is null
        or p.last_sent_at <= now() - make_interval(hours => ${REMINDER_COOLDOWN_HOURS}))
      and exists (
        select 1 from tanks t join fish f on f.tank_id = t.id
        where t.owner_id = p.user_id and f.status = 'alive')
      and not exists (
        select 1 from tanks t join events e on e.tank_id = t.id
        where t.owner_id = p.user_id and e.kind = 'feed'
          and e.at > now() - make_interval(hours => ${REMINDER_AFTER_UNFED_HOURS}))
    order by p.last_sent_at nulls first
    limit ${Math.min(deps.batch ?? DEFAULT_SWEEP_BATCH, remaining)}`);

  let sent = 0;
  for (const row of rows) {
    if (deps.shouldStop?.()) break;
    // Tracked before the claim commits so a shutdown during the claim cannot leave it unreleased.
    // The flag flips only after a send returns, so a release that lands mid-send can let the next
    // sweep after a restart send a second reminder; that is preferred to a user missing a day.
    const tracked: InflightClaim = { previous: row.last_sent_at, delivered: false };
    deps.inflight?.set(row.user_id, tracked);
    const claim = await claimReminder(db, row.user_id, deps.dailyCap).catch((err: unknown) => {
      deps.inflight?.delete(row.user_id);
      throw err;
    });
    if (claim !== 'claimed') {
      deps.inflight?.delete(row.user_id);
      if (claim === 'capped') return { sent, capped: true };
      continue;
    }

    const release = () =>
      db
        .update(schema.reminderPrefs)
        .set({ lastSentAt: row.last_sent_at })
        .where(eq(schema.reminderPrefs.userId, row.user_id));

    try {
      if (push && row.push_enabled) {
        const subs = await db
          .select()
          .from(schema.pushSubscriptions)
          .where(eq(schema.pushSubscriptions.userId, row.user_id));
        for (const sub of subs) {
          const result = await push.send(sub.endpoint);
          if (result === 'sent') {
            tracked.delivered = true;
            await db
              .update(schema.pushSubscriptions)
              .set({ lastUsedAt: sql`now()` })
              .where(eq(schema.pushSubscriptions.id, sub.id));
          }
          if (result === 'gone') {
            await db
              .delete(schema.pushSubscriptions)
              .where(eq(schema.pushSubscriptions.id, sub.id));
          }
        }
      }
      let stop = false;
      if (row.mail_enabled) {
        try {
          await mailer.sendReminder(
            row.email,
            appOrigin,
            unsubscribeUrl(appOrigin, authSecret, row.user_id),
          );
          tracked.delivered = true;
        } catch (err) {
          stop = true;
          if (!(err instanceof MailThrottledError)) {
            log(`reminder mail failed: ${err instanceof Error ? err.name : 'unknown'}`);
          }
        }
      }
      if (!tracked.delivered) await release();
      else {
        sent++;
        remaining--;
      }
      if (stop || remaining <= 0) break;
    } finally {
      deps.inflight?.delete(row.user_id);
    }
  }
  return { sent, capped: remaining <= 0 };
}

const SWEEP_INTERVAL_MS = 10 * 60_000;

export interface RunningReminders {
  stop(): void;
  releaseUnsent(): Promise<number>;
}

export function startReminders(
  deps: Omit<ReminderSweepDeps, 'shouldStop' | 'inflight'>,
  runInBackground: (task: Promise<void>) => void,
): RunningReminders {
  const inflight: InflightClaims = new Map();
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await sweepReminders({ ...deps, inflight, shouldStop: () => stopped });
    } catch (err) {
      console.error('reminder sweep failed:', err instanceof Error ? err.name : 'unknown');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => runInBackground(run()), SWEEP_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    releaseUnsent: () => releaseInflightClaims(deps.database, inflight),
  };
}
