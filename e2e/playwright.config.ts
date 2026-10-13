import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { APP_PORT, APP_URL, SINK_HTTP_PORT, SINK_SMTP_PORT, SINK_URL } from './support/env.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. The e2e suite needs a throwaway Postgres, for example ' +
      'postgres://aquarium:aquarium@localhost:5432/aquarium_e2e (see .github/workflows/ci.yml).',
  );
}

const inCi = process.env['CI'] !== undefined;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: inCi ? 1 : 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: inCi ? [['list'], ['github']] : [['list']],
  outputDir: './test-results',
  use: {
    baseURL: APP_URL,
    trace: 'retain-on-failure',
    viewport: { width: 800, height: 540 },
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  projects: [{ name: 'chromium-webgl', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: 'node e2e/support/mail-sink.ts',
      cwd: root,
      url: `${SINK_URL}/outbox`,
      reuseExistingServer: false,
      env: {
        SINK_SMTP_PORT: String(SINK_SMTP_PORT),
        SINK_HTTP_PORT: String(SINK_HTTP_PORT),
      },
    },
    {
      command: 'node --enable-source-maps apps/api/dist/server.js',
      cwd: root,
      url: `${APP_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        PORT: String(APP_PORT),
        APP_URL,
        DATABASE_URL: databaseUrl,
        BETTER_AUTH_SECRET: 'e2esecrete2esecrete2esecrete2esecret0',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(SINK_SMTP_PORT),
        WEB_DIST: 'apps/web/dist',
        SITE_INDEXABLE: 'false',
      },
    },
  ],
});
