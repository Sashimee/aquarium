import { randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import { createAuth, type Auth, DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimits } from './auth.ts';
import { connect, runMigrations, type Database } from './db/index.ts';
import { createClock, type Clock } from './clock.ts';
import { createMailer, DEFAULT_MAIL_LIMITS, type MailLimits } from './mail.ts';
import { loadCatalog } from './species.ts';
import type { LegalLimits } from './legal.ts';
import type { CareLimits } from './tanks.ts';

export const APP_ORIGIN = 'https://fish.test';

const GENEROUS = { window: 60, max: 10_000 };
const GENEROUS_MAIL: MailLimits = {
  perRecipient: { max: 10_000, windowMs: 60_000 },
  verificationCooldown: { max: 10_000, windowMs: 1000 },
  perIpSignup: { max: 10_000, windowMs: 60_000 },
};

export interface SentMail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface Harness {
  app: FastifyInstance;
  auth: Auth;
  database: Database;
  outbox: SentMail[];
  clock: Clock;
  dropDatabase(): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  indexable?: boolean;
  webRoot?: string;
  mailLimits?: MailLimits;
  authLimits?: AuthRateLimits;
  limited?: boolean;
  careLimits?: CareLimits;
  legalLimits?: LegalLimits;
  testHooks?: boolean;
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
  const transport = nodemailer.createTransport({
    name: 'test',
    version: '0',
    send(mail, done) {
      const data = mail.data;
      outbox.push({
        from: String(data.from),
        to: String(data.to),
        subject: String(data.subject),
        text: String(data.text),
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
  });

  const mailer = createMailer(
    transport,
    'fish@bas.lu',
    opts.mailLimits ?? (opts.limited ? DEFAULT_MAIL_LIMITS : GENEROUS_MAIL),
  );
  const auth = createAuth({
    config: {
      authSecret: 'testsecrettestsecrettestsecret0123456789',
      appUrl: new URL(APP_ORIGIN),
      trustedProxies: ['127.0.0.1'],
    },
    database,
    mailer,
    rateLimits:
      opts.authLimits ??
      (opts.limited
        ? DEFAULT_AUTH_RATE_LIMITS
        : {
            signIn: GENEROUS,
            signUp: GENEROUS,
            sendVerification: GENEROUS,
            passwordReset: GENEROUS,
          }),
  });
  const clock = createClock();
  const app = buildApp({
    indexable: opts.indexable ?? false,
    webRoot: opts.webRoot ?? '/nonexistent',
    appOrigin: APP_ORIGIN,
    trustedProxies: ['127.0.0.1'],
    database,
    auth,
    mailer,
    species: loadCatalog(),
    clock,
    testHooks: opts.testHooks ?? true,
    ...(opts.careLimits ? { careLimits: opts.careLimits } : {}),
    ...(opts.legalLimits ? { legalLimits: opts.legalLimits } : {}),
    logger: false,
  });
  await app.ready();

  return {
    app,
    auth,
    database,
    outbox,
    clock,
    dropDatabase: testDb.drop,
    async close() {
      await app.close();
      await database.close();
      await testDb.drop();
    },
  };
}
