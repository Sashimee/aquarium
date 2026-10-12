/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
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
    include: ['src/**/*.test.ts'],
  },
});
