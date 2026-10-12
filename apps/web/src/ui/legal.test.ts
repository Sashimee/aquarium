import { PRIVACY_POLICY, type Credits } from '@aquarium/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, createApiClient } from './api';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { deleteErrorMessage, rateLimitMessage, safeHref } from './legal';
import { CreditsView } from './screens';
import { guardRoute, parseRoute } from './router';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const apiError = (status: number, code: string, headers: Record<string, string> = {}) =>
  json({ error: { code, message: 'x' } }, status, headers);

const credits: Credits = {
  generatedFrom: 'assets/manifest.json',
  shareAlikeNotice: 'notice',
  entries: [
    {
      id: 'a',
      kind: 'model',
      title: 'Fish',
      author: 'Ann',
      authorUrl: 'https://example.com/ann',
      sourceUrl: 'https://example.com/fish',
      licence: 'CC-BY-4.0',
      licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
      attribution: 'Fish by Ann',
      shareAlike: false,
      referenceOnly: true,
      species: null,
      modifications: ['Retopologised'],
    },
  ],
};

describe('legal routes', () => {
  it('parses the public pages and keeps them open to signed-out visitors', () => {
    expect(parseRoute('/privacy')).toEqual({ name: 'privacy' });
    expect(parseRoute('/credits/')).toEqual({ name: 'credits' });
    expect(guardRoute({ name: 'privacy' }, null)).toEqual({ name: 'privacy' });
    expect(guardRoute({ name: 'credits' }, null)).toEqual({ name: 'credits' });
  });

  it('sends signed-out visitors from settings to sign-in', () => {
    expect(parseRoute('/settings')).toEqual({ name: 'settings' });
    expect(guardRoute({ name: 'settings' }, null)).toEqual({ name: 'sign-in' });
  });
});

describe('legal api', () => {
  it('validates privacy and credits with the shared schemas', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(PRIVACY_POLICY))
      .mockResolvedValueOnce(json(credits))
      .mockResolvedValueOnce(json({ nonsense: true }));
    const api = createApiClient(fetcher);
    expect((await api.privacy()).version).toBe(PRIVACY_POLICY.version);
    expect((await api.credits()).entries[0]?.referenceOnly).toBe(true);
    const bad = (await api.credits().catch((e) => e)) as ApiRequestError;
    expect(bad.code).toBe('unexpected_response');
  });

  it('rejects an export that does not match the schema', async () => {
    const api = createApiClient(vi.fn().mockResolvedValue(json({ format: 'other' })));
    const error = (await api.exportData().catch((e) => e)) as ApiRequestError;
    expect(error.code).toBe('unexpected_response');
  });

  it('posts the password for deletion, and an empty body for passkey accounts', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({}));
    const api = createApiClient(fetcher);
    await api.deleteAccount('hunter2hunter2');
    await api.deleteAccount('');
    const bodies = fetcher.mock.calls.map(([url, init]) => [
      url,
      JSON.parse((init as RequestInit).body as string),
    ]);
    expect(bodies).toEqual([
      ['/api/me/delete', { password: 'hunter2hunter2' }],
      ['/api/me/delete', {}],
    ]);
  });

  it('surfaces 429 with retry-after on export and delete', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(async () => apiError(429, 'rate_limited', { 'retry-after': '90' }));
    const api = createApiClient(fetcher);
    const del = (await api.deleteAccount('x').catch((e) => e)) as ApiRequestError;
    const exp = (await api.exportData().catch((e) => e)) as ApiRequestError;
    expect([del.code, del.retryAfterSeconds]).toEqual(['rate_limited', 90]);
    expect([exp.code, exp.retryAfterSeconds]).toEqual(['rate_limited', 90]);
  });
});

describe('error messages', () => {
  const err = (code: ApiRequestError['code'], retry: number | null = null) =>
    new ApiRequestError(code === 'rate_limited' ? 429 : 403, code, 'server text', {}, retry);

  it('states the wait for rate limits', () => {
    expect(rateLimitMessage(err('rate_limited', 30), 'export')).toContain('30 seconds');
    expect(rateLimitMessage(err('rate_limited', 90), 'export')).toContain('2 minutes');
    expect(rateLimitMessage(err('rate_limited', 60), 'export')).toContain('1 minute.');
    expect(rateLimitMessage(err('rate_limited'), 'export')).toContain('Wait a little');
  });

  it('shows the server message for deletion failures, whatever the account type', () => {
    expect(deleteErrorMessage(err('forbidden'))).toBe('server text');
    expect(deleteErrorMessage(err('rate_limited', 120))).toContain('2 minutes');
    const empty = new ApiRequestError(500, 'internal', '');
    expect(deleteErrorMessage(empty)).toContain('Could not delete');
  });
});

describe('safeHref', () => {
  it('allows only http and https', () => {
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHref('http://example.com')).toBe('http://example.com');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>1</script>')).toBeNull();
    expect(safeHref('vbscript:x')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
  });
});

describe('CreditsView', () => {
  it('renders hostile URLs as plain text', () => {
    const [base] = credits.entries;
    if (!base) throw new Error('fixture has no entry');
    const entry = {
      ...base,
      sourceUrl: 'javascript:alert(1)',
      authorUrl: 'data:text/html,x',
      licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
    };
    const html = renderToStaticMarkup(
      createElement(CreditsView, { credits: { ...credits, entries: [entry] } }),
    );
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text');
    expect(html).toContain('href="https://creativecommons.org/licenses/by/4.0/"');
    expect(html).toContain('Fish');
    expect(html).toContain('Ann');
  });
});
