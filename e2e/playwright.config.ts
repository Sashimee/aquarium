import { defineConfig } from '@playwright/test';

const port = Number(process.env['E2E_PORT'] ?? 4317);

export default defineConfig({
  testDir: '.',
  testMatch: ['*.spec.ts', 'tests/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: process.env['CI'] ? [['blob'], ['list']] : [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 800, height: 540 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: 'node e2e/build-server.mjs && node --enable-source-maps apps/api/dist/e2e-server.js',
    cwd: '..',
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
