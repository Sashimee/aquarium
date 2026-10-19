import { buildApp, DEFAULT_SIGN_IN_THROTTLE } from './app.ts';
import { createBackgroundTasks, shutdown } from './background.ts';
import { createAuth } from './auth.ts';
import { loadConfig } from './config.ts';
import { connect, runMigrations } from './db/index.ts';
import { createMailer, createSmtpTransport } from './mail.ts';
import { postgresHitStore } from './rate-limit.ts';
import { startMaintenance } from './maintenance.ts';
import { createPushSender } from './push.ts';
import { startReminders } from './reminders.ts';
import { loadCatalog } from './species.ts';

// Docker's default stop grace is 10 s; finish well inside it.
const SHUTDOWN_BUDGET_MS = 5500;
const HARD_EXIT_MS = 8000;

const config = loadConfig(process.env);

const database = connect(config.databaseUrl);
await runMigrations(database);

const mailer = createMailer(
  createSmtpTransport(config.smtp.host, config.smtp.port),
  config.mailFrom,
  { store: postgresHitStore(database, config.authSecret) },
);
const background = createBackgroundTasks();
const auth = createAuth({
  config,
  database,
  mailer,
  runInBackground: (task) => background.run(task),
});

const push = config.vapid ? createPushSender(config.vapid, config.vapidSubject) : null;

const app = buildApp({
  indexable: config.indexable,
  webRoot: config.webRoot,
  appOrigin: config.appUrl.origin,
  trustedProxies: config.trustedProxies,
  database,
  auth,
  mailer,
  signInThrottle: {
    store: postgresHitStore(database, config.authSecret),
    limit: DEFAULT_SIGN_IN_THROTTLE,
  },
  species: loadCatalog(),
  testHooks: config.testHooks,
  authSecret: config.authSecret,
  push,
});

const stopMaintenance = startMaintenance(database);
const stopReminders = startReminders({
  database,
  mailer,
  push,
  appOrigin: config.appUrl.origin,
  authSecret: config.authSecret,
  dailyCap: config.reminderDailyCap,
});

let shuttingDown: Promise<void> | undefined;

const stop = () => {
  if (shuttingDown) return;
  shuttingDown = shutdown({
    stopMaintenance: () => {
      stopMaintenance();
      stopReminders();
    },
    closeApp: () => app.close(),
    tasks: background,
    closeDatabase: () => database.close(),
    budgetMs: SHUTDOWN_BUDGET_MS,
  }).catch((err: unknown) => {
    console.error('shutdown failed:', err instanceof Error ? err.name : 'unknown');
    process.exitCode = 1;
  });
  // An abandoned task can hold a socket, or a pool client, open indefinitely.
  setTimeout(() => process.exit(1), HARD_EXIT_MS).unref();
  void shuttingDown.finally(() => process.exit(process.exitCode ?? 0));
};

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

await app.listen({ host: '0.0.0.0', port: config.port });
