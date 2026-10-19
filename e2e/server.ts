import { resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { buildApp } from '../apps/api/src/app.ts';
import { createAuth } from '../apps/api/src/auth.ts';
import { createClock } from '../apps/api/src/clock.ts';
import { connect, runMigrations } from '../apps/api/src/db/index.ts';
import { createMailer } from '../apps/api/src/mail.ts';
import { postgresHitStore } from '../apps/api/src/rate-limit.ts';
import { loadChemistryParameters } from '../apps/api/src/chemistry.ts';
import { loadCatalog } from '../apps/api/src/species.ts';
import { createTestDatabase } from '../apps/api/src/test-harness.ts';

const port = Number(process.env['E2E_PORT'] ?? 4317);
const origin = `http://localhost:${port}`;
const secret = 'e2esecrete2esecrete2esecrete2esecret01';
const generous = { window: 60, max: 100_000 };
const unlimited = { max: 100_000, windowMs: 60_000 };

interface SentMail {
  to: string;
  subject: string;
  text: string;
}
const outbox: SentMail[] = [];

const testDb = await createTestDatabase();
const database = connect(testDb.url);
await runMigrations(database);

const transport = nodemailer.createTransport({
  name: 'e2e',
  version: '0',
  send(mail, done) {
    const data = mail.data;
    outbox.push({ to: String(data.to), subject: String(data.subject), text: String(data.text) });
    done(null, {
      envelope: { from: false, to: [] },
      messageId: 'e2e',
      accepted: [],
      rejected: [],
      pending: [],
      response: 'ok',
    });
  },
});

const mailer = createMailer(transport, 'fish@bas.lu', {
  limits: {
    perRecipient: unlimited,
    verificationCooldown: { max: 100_000, windowMs: 1000 },
    perIpSignup: unlimited,
    global: unlimited,
  },
  store: postgresHitStore(database, secret),
});
const auth = createAuth({
  config: { authSecret: secret, appUrl: new URL(origin), trustedProxies: ['127.0.0.1'] },
  database,
  mailer,
  rateLimits: {
    signIn: generous,
    signUp: generous,
    sendVerification: generous,
    passwordReset: generous,
  },
});

const app = buildApp({
  indexable: false,
  webRoot: resolve(process.cwd(), 'apps/web/dist'),
  appOrigin: origin,
  trustedProxies: ['127.0.0.1'],
  database,
  auth,
  mailer,
  signInThrottle: { store: postgresHitStore(database, secret), limit: unlimited },
  species: loadCatalog(),
  chemistryParams: loadChemistryParameters(),
  clock: createClock(),
  testHooks: true,
  logger: false,
});

app.get('/__e2e/outbox', async () => outbox);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => database.close())
      .then(() => testDb.drop())
      .finally(() => process.exit(0));
  });
}

await app.listen({ host: '127.0.0.1', port });
