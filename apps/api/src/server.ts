import { buildApp } from './app.ts';

const app = buildApp({
  indexable: process.env['SITE_INDEXABLE'] === 'true',
  webRoot: process.env['WEB_DIST'] ?? '../web/dist',
});

await app.listen({ host: '0.0.0.0', port: Number(process.env['PORT'] ?? 3000) });
