import { buildApp } from './app.ts';
import { createAuth } from './auth.ts';
import { loadConfig } from './config.ts';
import { connect, runMigrations } from './db/index.ts';
import { createMailer, createSmtpTransport } from './mail.ts';

const config = loadConfig(process.env);

const database = connect(config.databaseUrl);
await runMigrations(database);

const mailer = createMailer(
  createSmtpTransport(config.smtp.host, config.smtp.port),
  config.mailFrom,
);
const auth = createAuth({ config, database, mailer });

const app = buildApp({
  indexable: config.indexable,
  webRoot: config.webRoot,
  appOrigin: config.appUrl.origin,
  trustedProxies: config.trustedProxies,
  database,
  auth,
  mailer,
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(() => database.close());
  });
}

await app.listen({ host: '0.0.0.0', port: config.port });
