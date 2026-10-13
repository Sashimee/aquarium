import { buildApp } from './app.ts';
import { createBackgroundTasks, shutdown } from './background.ts';
import { createAuth } from './auth.ts';
import { loadConfig } from './config.ts';
import { connect, runMigrations } from './db/index.ts';
import { createMailer, createSmtpTransport } from './mail.ts';
import { postgresHitStore } from './rate-limit.ts';
import { startMaintenance } from './maintenance.ts';
import { loadCatalog } from './species.ts';

const DRAIN_TIMEOUT_MS = 10_000;

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

const app = buildApp({
  indexable: config.indexable,
  webRoot: config.webRoot,
  appOrigin: config.appUrl.origin,
  trustedProxies: config.trustedProxies,
  database,
  auth,
  mailer,
  species: loadCatalog(),
  testHooks: config.testHooks,
});

const stopMaintenance = startMaintenance(database);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    shutdown({
      stopMaintenance,
      closeApp: () => app.close(),
      tasks: background,
      closeDatabase: () => database.close(),
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    }).catch((err: unknown) => {
      console.error('shutdown failed:', err instanceof Error ? err.name : 'unknown');
      process.exitCode = 1;
    });
  });
}

await app.listen({ host: '0.0.0.0', port: config.port });
