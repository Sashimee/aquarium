import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';

const NOINDEX = 'noindex, nofollow';
let dist: string;

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'aquarium-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>spa</title>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dist, '.env'), 'SECRET=1');
});

afterAll(() => rmSync(dist, { recursive: true, force: true }));

const noDist = () => buildApp({ indexable: false, webRoot: '/nonexistent', logger: false });
const withDist = (indexable = false) => buildApp({ indexable, webRoot: dist, logger: false });

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
    for (const url of ['/api', '/api?x=1', '/api/', '/api/nope', '/api/nope?x=1']) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toContain('application/json');
    }
    expect((await app.inject({ method: 'HEAD', url: '/api/nope' })).statusCode).toBe(404);
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
