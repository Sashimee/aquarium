import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';

const webRoot = '/nonexistent';

describe('placeholder app', () => {
  it('serves health', async () => {
    const res = await buildApp({ indexable: false, webRoot }).inject('/api/health');
    expect(res.statusCode).toBe(200);
  });

  it('is noindex on every response when not indexable', async () => {
    const app = buildApp({ indexable: false, webRoot });
    for (const url of ['/', '/api/health', '/robots.txt', '/api/nope', '/some/spa/route']) {
      const res = await app.inject(url);
      expect(res.headers['x-robots-tag'], url).toBe('noindex, nofollow');
    }
    expect((await app.inject('/robots.txt')).body).toContain('Disallow: /');
  });

  it('omits noindex when indexable', async () => {
    const app = buildApp({ indexable: true, webRoot });
    const res = await app.inject('/');
    expect(res.headers['x-robots-tag']).toBeUndefined();
    expect((await app.inject('/robots.txt')).body).not.toContain('Disallow: /\n');
  });

  it('returns 404 under /api', async () => {
    const res = await buildApp({ indexable: false, webRoot }).inject('/api/nope');
    expect(res.statusCode).toBe(404);
  });
});
