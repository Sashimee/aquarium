/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { ktx2WorkerPlugin } from './build/ktx2-worker-plugin.ts';
import { swBuildIdPlugin } from './build/sw-build-id-plugin.ts';
import { tankPreloadPlugin } from './build/tank-preload-plugin.ts';
import { vitestGlobCachePlugin } from './build/vitest-glob-cache-plugin.ts';

// The citations are for the server and the docs; the client only shows the thresholds.
function stripCoralSources(): Plugin {
  return {
    name: 'strip-coral-sources',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/content/corals.json')) return null;
      const content = JSON.parse(code) as { params: { sources?: unknown } };
      content.params.sources = {};
      return JSON.stringify(content);
    },
  };
}

export default defineConfig({
  plugins: [
    stripCoralSources(),
    ktx2WorkerPlugin(),
    tankPreloadPlugin(),
    swBuildIdPlugin(),
    vitestGlobCachePlugin(),
  ],
  build: {
    target: ['es2022', 'safari16'],
    sourcemap: false,
    manifest: true,
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
    execArgv: ['--expose-gc'],
  },
});
