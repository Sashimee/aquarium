/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { ktx2WorkerPlugin } from './build/ktx2-worker-plugin.ts';
import { swBuildIdPlugin } from './build/sw-build-id-plugin.ts';
import { tankPreloadPlugin } from './build/tank-preload-plugin.ts';
import { vitestGlobCachePlugin } from './build/vitest-glob-cache-plugin.ts';

export default defineConfig({
  plugins: [ktx2WorkerPlugin(), tankPreloadPlugin(), swBuildIdPlugin(), vitestGlobCachePlugin()],
  build: {
    target: ['es2022', 'safari16'],
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    // The proxy keeps the browser's Origin, so run the API with APP_URL=http://localhost:5173 or
    // cookie-bearing POSTs (sign-out, revoke) are rejected by its origin checks.
    proxy: { '/api': process.env['API_URL'] ?? 'http://localhost:3000' },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'build/**/*.test.ts'],
  },
});
