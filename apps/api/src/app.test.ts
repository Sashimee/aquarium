import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { staticCacheControl } from './app.ts';
import { createHarness, type Harness } from './test-harness.ts';

const NOINDEX = 'noindex, nofollow';
const BUNDLE = 'console.log("hello aquarium");'.repeat(200);
let dist: string;
let plain: Harness;
let spa: Harness;
let indexable: Harness;

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'aquarium-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>spa</title>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dist, 'assets', 'index-C7vUOBtl.js'), BUNDLE);
  writeFileSync(join(dist, 'assets', 'index-C7vUOBtl.js.br'), brotliCompressSync(BUNDLE));
  writeFileSync(join(dist, 'assets', 'index-C7vUOBtl.js.gz'), gzipSync(BUNDLE));
  writeFileSync(join(dist, 'assets', 'index.json'), '{}');
  mkdirSync(join(dist, 'assets', 'fish'));
  writeFileSync(join(dist, 'assets', 'fish', 'tetra.glb'), 'glb');
  writeFileSync(join(dist, '.env'), 'SECRET=1');
  [plain, spa, indexable] = await Promise.all([
    createHarness(),
    createHarness({ webRoot: dist }),
    createHarness({ webRoot: dist, indexable: true }),
  ]);
});

afterAll(async () => {
  await Promise.all([plain.close(), spa.close(), indexable.close()]);
  rmSync(dist, { recursive: true, force: true });
});

const noDist = (): FastifyInstance => plain.app;
const withDist = (isIndexable = false): FastifyInstance => (isIndexable ? indexable.app : spa.app);

describe('health', () => {
  it('reports ok while the database answers', async () => {
    const res = await plain.app.inject('/api/health');
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('reports 503 when the database is gone', async () => {
    const broken = await createHarness();
    await broken.database.pool.end();
    const res = await broken.app.inject('/api/health');
    expect(res.statusCode).toBe(503);
    expect(res.headers['x-robots-tag']).toBe(NOINDEX);
    await broken.app.close();
    await broken.dropDatabase();
  });
});

describe('without a web build', () => {
  it('serves health', async () => {
    expect((await noDist().inject('/api/health')).statusCode).toBe(200);
  });

  it('serves the hello page for GET and HEAD', async () => {
    const app = noDist();
    expect((await app.inject('/')).statusCode).toBe(200);
    expect((await app.inject({ method: 'HEAD', url: '/' })).statusCode).toBe(200);
  });
});

describe('with a web build', () => {
  it('serves static files', async () => {
    const res = await withDist().inject('/assets/app.js');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log(1)');
  });

  it('serves hashed bundles brotli, gzip or identity by Accept-Encoding', async () => {
    const app = withDist();
    const url = '/assets/index-C7vUOBtl.js';

    const br = await app.inject({ url, headers: { 'accept-encoding': 'gzip, br' } });
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['content-type']).toContain('javascript');
    expect(br.headers['vary']).toContain('accept-encoding');
    expect(brotliDecompressSync(br.rawPayload).toString()).toBe(BUNDLE);

    const gz = await app.inject({ url, headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.rawPayload).toString()).toBe(BUNDLE);

    const identity = await app.inject({ url });
    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(identity.body).toBe(BUNDLE);
  });

  it('honours q-values and q=0 refusals', async () => {
    const res = await withDist().inject({
      url: '/assets/index-C7vUOBtl.js',
      headers: { 'accept-encoding': 'br;q=0, gzip' },
    });
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('answers Range requests on uncompressed files with 206', async () => {
    const res = await withDist().inject({
      url: '/assets/fish/tetra.glb',
      headers: { range: 'bytes=0-1' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.body).toBe('gl');
  });

  it('never marks a file from apps/web/public immutable, in place or flattened into assets/', () => {
    const publicDir = fileURLToPath(new URL('../../web/public', import.meta.url));
    const files = readdirSync(publicDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(publicDir, join(entry.parentPath, entry.name)));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(staticCacheControl(file), file).not.toContain('immutable');
      expect(staticCacheControl(join('assets', basename(file))), file).not.toContain('immutable');
    }
  });

  it('caches by how stable the file name is', async () => {
    const app = withDist();
    const cache = async (url: string): Promise<unknown> =>
      (await app.inject({ url, headers: { 'accept-encoding': 'br' } })).headers['cache-control'];
    expect(await cache('/assets/index-C7vUOBtl.js')).toBe('public, max-age=31536000, immutable');
    for (const name of ['index-C-nEAlfU.js', 'system--58a3A-e.js']) {
      writeFileSync(join(dist, 'assets', name), 'x');
      expect(await cache(`/assets/${name}`), name).toBe('public, max-age=31536000, immutable');
    }
    expect(await cache('/assets/fish/tetra.glb')).toBe('public, max-age=3600');
    expect(await cache('/assets/index.json')).toBe('no-cache');
    expect(await cache('/index.html')).toBe('no-cache');
    expect(await cache('/')).toBe('no-cache');
    expect(await cache('/tank/42')).toBe('no-cache');
  });

  it('falls back to index.html for SPA routes, GET and HEAD', async () => {
    const app = withDist();
    const get = await app.inject('/tank/42');
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain('<title>spa</title>');
    expect((await app.inject({ method: 'HEAD', url: '/tank/42' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'HEAD', url: '/' })).statusCode).toBe(200);
  });

  it('returns JSON 404 for anything under /api', async () => {
    const app = withDist();
    const urls = [
      '/api',
      '/api?x=1',
      '/api/',
      '/api/nope',
      '/api/nope?x=1',
      '/api%2fnope',
      '/api%2Fnope',
      '//api/nope',
      '///api',
      '/%61pi/nope',
    ];
    for (const url of urls) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toContain('application/json');
    }
    expect((await app.inject({ method: 'HEAD', url: '/api/nope' })).statusCode).toBe(404);
  });

  it('serves the SPA for routes whose last segment contains a dot', async () => {
    const app = withDist();
    for (const url of ['/tank/v1.2', '/tank/a.b.c', '/u/mr.fish']) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain('<title>spa</title>');
    }
  });

  it('returns 404 for missing files with an extension', async () => {
    const res = await withDist().inject('/assets/missing.js');
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<title>spa</title>');
  });

  it('does not serve dotfiles', async () => {
    const res = await withDist().inject('/.env');
    expect(res.body).not.toContain('SECRET');
    expect(res.body).toContain('<title>spa</title>');
  });

  it('rejects non-GET methods on unknown routes', async () => {
    expect((await withDist().inject({ method: 'POST', url: '/tank/42' })).statusCode).toBe(404);
  });
});

describe('indexing', () => {
  it('sends noindex on every response when not indexable', async () => {
    const app = withDist(false);
    const requests = [
      { method: 'GET', url: '/' },
      { method: 'HEAD', url: '/' },
      { method: 'GET', url: '/assets/app.js' },
      { method: 'GET', url: '/tank/42' },
      { method: 'GET', url: '/assets/missing.js' },
      { method: 'GET', url: '/api/health' },
      { method: 'GET', url: '/api/nope' },
      { method: 'GET', url: '/api' },
      { method: 'GET', url: '/robots.txt' },
      { method: 'GET', url: '/.env' },
    ] as const;
    for (const r of requests) {
      const res = await app.inject(r);
      expect(res.headers['x-robots-tag'], `${r.method} ${r.url}`).toBe(NOINDEX);
    }
    expect((await app.inject('/robots.txt')).body).toContain('Disallow: /');
  });

  it('omits noindex and allows crawling when indexable', async () => {
    const app = withDist(true);
    const res = await app.inject('/');
    expect(res.headers['x-robots-tag']).toBeUndefined();
    expect((await app.inject('/robots.txt')).body).not.toContain('Disallow: /');
  });
});
