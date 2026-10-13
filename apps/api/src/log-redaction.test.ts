import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactUrl } from './app.ts';
import { APP_ORIGIN, createHarness, type Harness } from './test-harness.ts';

describe('redactUrl', () => {
  it.each([
    ['/api/auth/reset-password/abc123', '/api/auth/reset-password/[redacted]'],
    ['/api/auth/reset-password/abc123?callbackURL=/x', '/api/auth/reset-password/[redacted]'],
    ['//api/auth/reset-password/abc123', '/api/auth/reset-password/[redacted]'],
    ['/API/auth/Reset-Password/abc123/more', '/API/auth/Reset-Password/[redacted]'],
    ['/api/auth/callback/google', '/api/auth/callback/[redacted]'],
    ['/api/auth/verify-email?token=secret', '/api/auth/verify-email'],
    ['/api/auth/some-new/aB3dE5gH7jK9mN1pQ3sT5v', '/api/auth/some-new/[redacted]'],
    ['/api/auth/request-password-reset', '/api/auth/request-password-reset'],
    ['/api/health', '/api/health'],
  ])('%s -> %s', (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });
});

describe('request logging', () => {
  let h: Harness;
  const lines: string[] = [];
  const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };

  beforeAll(async () => {
    h = await createHarness({ logStream: { write: (chunk) => void lines.push(chunk) } });
  });
  afterAll(async () => {
    await h.app.close();
    await h.dropDatabase();
  });

  it('never writes a reset token to the log', async () => {
    const email = `logs-${Date.now()}@bas.lu`;
    await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: jsonHeaders,
      payload: { email, password: 'correct horse battery', name: 'Tester', callbackURL: '/' },
    });
    await h.app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      headers: jsonHeaders,
      payload: { email, redirectTo: '/' },
    });
    const mail = [...h.outbox].reverse().find((m) => m.to === email && /reset/i.test(m.subject));
    const token = /reset-password\/([A-Za-z0-9]+)/.exec(mail?.text ?? '')?.[1];
    expect(token).toBeTruthy();

    const click = await h.app.inject({
      method: 'GET',
      url: `/api/auth/reset-password/${token}?callbackURL=/reset`,
    });
    expect(click.statusCode).toBe(302);
    await h.app.inject({ method: 'GET', url: `/api/auth/reset-password/${token}/nope` });
    await h.app.inject({ method: 'GET', url: `/api/auth/reset-password/bad${token}` });

    const log = lines.join('');
    expect(log).toContain('/api/auth/reset-password/[redacted]');
    expect(log).not.toContain(token as string);
    expect(log).not.toContain('bad' + token);
  });
});
