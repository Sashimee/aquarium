import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Economy } from '@aquarium/shared';
import nodemailer from 'nodemailer';
import pg from 'pg';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp, DEFAULT_SIGN_IN_THROTTLE } from './app.ts';
import type { Limit } from './rate-limit.ts';
import { createAuth, type Auth, DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimits } from './auth.ts';
import { connect, runMigrations, type Database } from './db/index.ts';
import { createClock, type Clock } from './clock.ts';
import { createMailer, DEFAULT_MAIL_LIMITS, type Mailer, type MailLimits } from './mail.ts';
import { postgresHitStore, type HitStore } from './rate-limit.ts';
import { loadChemistryParameters } from './chemistry.ts';
import { loadEconomy } from './economy.ts';
import { loadCatalog } from './species.ts';
import type { LegalLimits } from './legal.ts';
import type { CareLimits } from './tanks.ts';
import type { PushSender } from './push.ts';
import type { ReminderLimits } from './reminders.ts';
import type { PublicLimits } from './public.ts';

const cheapKey = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 32, { N: 1024, r: 8, p: 1 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );

const TEST_PASSWORD_HASHER = {
  hash: async (password: string) => {
    const salt = randomBytes(16);
    return `${salt.toString('hex')}:${(await cheapKey(password, salt)).toString('hex')}`;
  },
  verify: async ({ hash, password }: { hash: string; password: string }) => {
    const [salt, key] = hash.split(':');
    if (!salt || !key) return false;
    const expected = Buffer.from(key, 'hex');
    const actual = await cheapKey(password, Buffer.from(salt, 'hex'));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  },
};

export const TEST_SECRET = 'testsecrettestsecrettestsecret0123456789';
export const APP_ORIGIN = 'https://fish.test';

const MAX_DRAIN_ROUNDS = 100;

const GENEROUS = { window: 60, max: 10_000 };
const GENEROUS_MAIL: MailLimits = {
  perRecipient: { max: 10_000, windowMs: 60_000 },
  verificationCooldown: { max: 10_000, windowMs: 1000 },
  perIpSignup: { max: 10_000, windowMs: 60_000 },
  global: { max: 10_000, windowMs: 60_000 },
};

export interface SentMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
}

type PromiseInject = (opts: string | InjectOptions) => Promise<LightMyRequestResponse>;

export interface Harness {
  app: FastifyInstance;
  auth: Auth;
  database: Database;
  mailer: Mailer;
  outbox: SentMail[];
  clock: Clock;
  settleMail(): Promise<void>;
  rawInject: PromiseInject;
  holdMail(): { sendStarted: Promise<void>; release(): void; fail(err: Error): void };
  dropDatabase(): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  indexable?: boolean;
  webRoot?: string;
  mailLimits?: MailLimits;
  wrapMailStore?: (store: HitStore) => HitStore;
  authLimits?: AuthRateLimits;
  limited?: boolean;
  signInThrottle?: Limit;
  careLimits?: CareLimits;
  legalLimits?: LegalLimits;
  handleLimit?: Limit;
  collectionLimit?: Limit;
  publicLimits?: PublicLimits;
  testHooks?: boolean;
  push?: PushSender | null;
  reminderLimits?: ReminderLimits;
  mailDelayMs?: number;
  appOrigin?: string;
  economy?: Economy;
  logStream?: { write(chunk: string): void };
}

function baseUrl(): URL {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. API tests need a real Postgres, for example ' +
        'postgres://aquarium:aquarium@localhost:5432/aquarium_test (see .github/workflows/ci.yml).',
    );
  }
  return new URL(url);
}

export async function createTestDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const base = baseUrl();
  const name = `aq_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const dropper = new pg.Client({ connectionString: base.toString() });
      await dropper.connect();
      await dropper.query(`drop database if exists ${name} with (force)`);
      await dropper.end();
    },
  };
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const testDb = await createTestDatabase();
  const database = connect(testDb.url);
  await runMigrations(database);

  const outbox: SentMail[] = [];
  let gate: Promise<void> = Promise.resolve();
  let onSend: () => void = () => {};
  let held = false;
  const releasers = new Set<() => void>();
  const transport = nodemailer.createTransport({
    name: 'test',
    version: '0',
    send(mail, done) {
      const data = mail.data;
      onSend();
      const delayed = opts.mailDelayMs
        ? new Promise<void>((resolve) => setTimeout(resolve, opts.mailDelayMs))
        : undefined;
      Promise.all([delayed, gate]).then(
        () => {
          outbox.push({
            from: String(data.from),
            to: String(data.to),
            subject: String(data.subject),
            text: String(data.text),
            headers: Object.fromEntries(
              Object.entries((data.headers ?? {}) as Record<string, unknown>).map(([k, v]) => [
                k,
                String(v),
              ]),
            ),
          });
          done(null, {
            envelope: { from: false, to: [] },
            messageId: 'test',
            accepted: [],
            rejected: [],
            pending: [],
            response: 'ok',
          });
        },
        (err: Error) => done(err),
      );
    },
  });

  const mailer = createMailer(transport, 'fish@bas.lu', {
    limits: opts.mailLimits ?? (opts.limited ? DEFAULT_MAIL_LIMITS : GENEROUS_MAIL),
    store: (opts.wrapMailStore ?? ((store) => store))(postgresHitStore(database, TEST_SECRET)),
  });
  const background = new Set<Promise<void>>();
  const auth = createAuth({
    config: {
      authSecret: TEST_SECRET,
      appUrl: new URL(opts.appOrigin ?? APP_ORIGIN),
      trustedProxies: ['127.0.0.1'],
    },
    database,
    mailer,
    password: TEST_PASSWORD_HASHER,
    runInBackground: (task) => {
      background.add(task);
      void task.finally(() => background.delete(task));
    },
    rateLimits:
      opts.authLimits ??
      (opts.limited
        ? DEFAULT_AUTH_RATE_LIMITS
        : {
            signIn: GENEROUS,
            signUp: GENEROUS,
            sendVerification: GENEROUS,
            passwordReset: GENEROUS,
            changePassword: GENEROUS,
          }),
  });
  const clock = createClock();
  const app = buildApp({
    indexable: opts.indexable ?? false,
    webRoot: opts.webRoot ?? '/nonexistent',
    appOrigin: opts.appOrigin ?? APP_ORIGIN,
    trustedProxies: ['127.0.0.1'],
    database,
    auth,
    mailer,
    signInThrottle: {
      store: postgresHitStore(database, TEST_SECRET),
      limit: opts.signInThrottle ?? { max: 10_000, windowMs: DEFAULT_SIGN_IN_THROTTLE.windowMs },
    },
    species: loadCatalog(),
    chemistryParams: loadChemistryParameters(),
    economy: opts.economy ?? loadEconomy(),
    clock,
    testHooks: opts.testHooks ?? true,
    authSecret: TEST_SECRET,
    push: opts.push ?? null,
    ...(opts.reminderLimits ? { reminderLimits: opts.reminderLimits } : {}),
    ...(opts.careLimits ? { careLimits: opts.careLimits } : {}),
    ...(opts.legalLimits ? { legalLimits: opts.legalLimits } : {}),
    ...(opts.handleLimit ? { handleLimit: opts.handleLimit } : {}),
    ...(opts.collectionLimit ? { collectionLimit: opts.collectionLimit } : {}),
    ...(opts.publicLimits ? { publicLimits: opts.publicLimits } : {}),
    logger: opts.logStream !== undefined,
    ...(opts.logStream ? { logStream: opts.logStream } : {}),
  });
  await app.ready();

  // Mail leaves the response path, so tests that read the outbox right after a request need it settled.
  // Timing tests use rawInject to measure the response alone.
  const originalInject = app.inject.bind(app) as PromiseInject;
  const rawInject: PromiseInject = (opts) => originalInject(opts);
  const settledInject: PromiseInject = async (opts) => {
    const res = await rawInject(opts);
    if (!held) await Promise.all([...background]);
    return res;
  };
  app.inject = settledInject as typeof app.inject;

  return {
    rawInject,
    app,
    auth,
    database,
    mailer,
    outbox,
    clock,
    holdMail() {
      let release!: () => void;
      let fail!: (err: Error) => void;
      held = true;
      gate = new Promise<void>((resolve, reject) => {
        release = () => {
          held = false;
          resolve();
        };
        fail = (err) => {
          held = false;
          reject(err);
        };
      });
      gate.catch(() => {});
      releasers.add(release);
      const sendStarted = new Promise<void>((resolve) => (onSend = resolve));
      return { sendStarted, release, fail };
    },
    async settleMail() {
      await Promise.all([...background]);
    },
    dropDatabase: testDb.drop,
    async close() {
      for (const release of releasers) release();
      const failures: unknown[] = [];
      for (const step of [
        async () => {
          for (let rounds = 0; background.size > 0; rounds++) {
            if (rounds >= MAX_DRAIN_ROUNDS) {
              throw new Error(
                `background work still queued after ${MAX_DRAIN_ROUNDS} drain rounds; a task keeps scheduling more`,
              );
            }
            await Promise.allSettled([...background]);
          }
        },
        () => app.close(),
        () => database.close(),
        () => testDb.drop(),
      ]) {
        try {
          await step();
        } catch (err) {
          failures.push(err);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, 'several harness teardown steps failed');
    },
  };
}

export function fishPayload(species: string, name: string, stage: 'juvenile' | 'adult' = 'adult') {
  return { species, name, stage, idempotencyKey: randomUUID() };
}

// Raises every account that holds less than `amount` Pearls by `amount`, so a test that buys many
// fish or tanks isn't limited by the starting grant.
export async function topUp(h: Harness, amount = 100_000): Promise<void> {
  await h.database.db.execute(sql`
    with topped as (
      insert into wallet (user_id, balance)
      select id, ${amount} from "user"
      on conflict (user_id) do update set balance = wallet.balance + ${amount}
        where wallet.balance < ${amount}
      returning user_id
    )
    insert into ledger (user_id, delta, reason, source, item_ref, idempotency_key, created_at)
    select user_id, ${amount}, 'grant', 'game', 'grant:test-topup',
      'test-topup-' || gen_random_uuid(), now()
    from topped
  `);
}
