import { createECDH, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { buildApp } from '../apps/api/src/app.ts';
import { createAuth } from '../apps/api/src/auth.ts';
import { createClock } from '../apps/api/src/clock.ts';
import { connect, runMigrations } from '../apps/api/src/db/index.ts';
import { createMailer } from '../apps/api/src/mail.ts';
import { createStripeProvider } from '../apps/api/src/payments/provider.ts';
import { createPushSender, parseVapidKeys } from '../apps/api/src/push.ts';
import { postgresHitStore } from '../apps/api/src/rate-limit.ts';
import { loadChemistryParameters } from '../apps/api/src/chemistry.ts';
import { DEFAULT_CARE_LIMITS } from '../apps/api/src/tanks.ts';
import { loadEconomy } from '../apps/api/src/economy.ts';
import { loadCatalog } from '../apps/api/src/species.ts';
import { createTestDatabase } from '../apps/api/src/test-harness.ts';
import { E2E_STRIPE_SECRET_KEY, E2E_WEBHOOK_SECRET } from './support/stripe.ts';

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

const baseEconomy = loadEconomy();
const economy = {
  ...baseEconomy,
  grants: { ...baseEconomy.grants, starting: 100_000 },
};

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const vapid = parseVapidKeys(
  ecdh.getPublicKey().toString('base64url'),
  ecdh.getPrivateKey().toString('base64url'),
);

const stripeMock = new URL(process.env['STRIPE_MOCK_URL'] ?? 'http://localhost:12111');
const payments = createStripeProvider({
  secretKey: E2E_STRIPE_SECRET_KEY,
  webhookSecret: E2E_WEBHOOK_SECRET,
  endpoint: {
    host: stripeMock.hostname,
    port: Number(stripeMock.port || 80),
    protocol: stripeMock.protocol === 'https:' ? 'https' : 'http',
  },
});

const app = buildApp({
  payments,
  push: createPushSender(vapid, 'mailto:fish@bas.lu'),
  indexable: false,
  webRoot: resolve(process.cwd(), 'apps/web/dist'),
  appOrigin: origin,
  authSecret: secret,
  trustedProxies: ['127.0.0.1'],
  database,
  auth,
  mailer,
  signInThrottle: { store: postgresHitStore(database, secret), limit: unlimited },
  species: loadCatalog(),
  chemistryParams: loadChemistryParameters(),
  clock: createClock(),
  economy,
  careLimits: { ...DEFAULT_CARE_LIMITS, addFish: unlimited, feed: unlimited },
  testHooks: true,
  logger: false,
});

app.get('/__e2e/outbox', async () => outbox);

interface SetBalanceBody {
  email: string;
  balance: number;
}

// Moves a wallet to an exact balance through a game-sourced 'grant' row labelled e2e:set-balance, so
// the balance still equals the sum of the ledger and no fake payment rows appear. Open /api/wallet first: that creates the wallet.
app.post('/__e2e/set-balance', async (req, reply) => {
  const body = req.body as Partial<SetBalanceBody> | null;
  if (
    typeof body?.email !== 'string' ||
    typeof body.balance !== 'number' ||
    !Number.isInteger(body.balance)
  ) {
    return reply.code(400).send({ error: 'body must be {email: string, balance: integer}' });
  }
  const { email, balance } = body as SetBalanceBody;
  const client = await database.pool.connect();
  try {
    await client.query('begin');
    const found = await client.query<{ balance: number }>(
      'select w.balance from wallet w join "user" u on u.id = w.user_id where u.email = $1 for update of w',
      [email.toLowerCase()],
    );
    const current = found.rows[0]?.balance;
    if (current === undefined) {
      await client.query('rollback');
      return reply.code(404).send({ error: 'no wallet for that email; open /api/wallet first' });
    }
    const delta = balance - current;
    if (delta !== 0) {
      await client.query(
        `insert into ledger (user_id, delta, reason, source, item_ref, idempotency_key)
         select u.id, $2, 'grant'::ledger_reason, 'game', 'e2e:set-balance', $3 from "user" u where u.email = $1`,
        [email.toLowerCase(), delta, `e2e-${randomUUID()}`],
      );
      await client.query(
        'update wallet set balance = $2 where user_id = (select id from "user" where email = $1)',
        [email.toLowerCase(), balance],
      );
    }
    await client.query('commit');
    return reply.code(204).send();
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
});

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
