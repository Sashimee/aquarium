import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { safeError } from './safe-error.ts';
import { redactUrl } from './app.ts';
import { APP_ORIGIN, createHarness, type Harness } from './test-harness.ts';

describe('redactUrl', () => {
  it.each([
    ['/api/auth/reset-password/abc123', '/api/auth/reset-password/[redacted]'],
    ['/api/auth/reset-password/abc123?callbackURL=/x', '/api/auth/reset-password/[redacted]'],
    ['//api/auth/reset-password/abc123', '/api/auth/reset-password/[redacted]'],
    ['/API/auth/Reset-Password/abc123/more', '/API/auth/Reset-Password/[redacted]'],
    ['/api/auth/callback/google', '/api/auth/callback/google'],
    ['/api/auth/callback/google?code=secret&state=s', '/api/auth/callback/google'],
    ['/api/auth/callback/google/extra', '/api/auth/callback/google'],
    ['/api//auth/reset-password/abc123', '/api/auth/reset-password/[redacted]'],
    ['/api/auth/reset-password%2Fabc123', '/api/auth/reset-password/[redacted]'],
    ['/api%2Fauth%2Freset-password%2Fabc123', '/api/auth/reset-password/[redacted]'],
    ['/api/auth/some-new/abcdefghijklmnopqrstuvwx', '/api/auth/some-new/[redacted]'],
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
    await h.settleMail();
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

describe('safeError', () => {
  it('drops driver params, detail and parameters but keeps the diagnosis', () => {
    const pgErr = Object.assign(new Error('relation "verification" does not exist'), {
      code: '42P01',
      detail: 'Key (email)=(victim@bas.lu) already exists.',
      parameters: ['tok-secret'],
      params: ['tok-secret'],
    });
    const wrapped = new Error(
      'Failed query: insert into "verification" values ($1)\nparams: tok-secret,victim@bas.lu',
      {
        cause: pgErr,
      },
    );
    const out = JSON.stringify(safeError(wrapped));
    expect(out).not.toContain('tok-secret');
    expect(out).not.toContain('victim@bas.lu');
    expect(out).toContain('Failed query');
    expect(out).toContain('42P01');
  });

  it('never prints non-error values', () => {
    expect(JSON.stringify(safeError({ token: 'tok-secret' }))).not.toContain('tok-secret');
  });
});

describe('database failures do not leak values', () => {
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

  it('keeps the reset token out of Better Auth and app logs when the insert fails', async () => {
    const email = `dbfail-${Date.now()}@bas.lu`;
    await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: jsonHeaders,
      payload: { email, password: 'correct horse battery', name: 'Tester', callbackURL: '/' },
    });
    const printed: string[] = [];
    const spies = (['error', 'warn', 'log'] as const).map((k) =>
      vi
        .spyOn(console, k)
        .mockImplementation((...a: unknown[]) => void printed.push(a.map(String).join(' '))),
    );
    try {
      await h.database.pool.query('alter table verification rename to verification_gone');
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/request-password-reset',
        headers: jsonHeaders,
        payload: { email, redirectTo: '/' },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      await h.database.pool.query('alter table verification_gone rename to verification');
      spies.forEach((s) => s.mockRestore());
    }
    const output = printed.join('\n') + lines.join('');
    expect(output).toMatch(/does not exist|Failed/i);
    expect(output).not.toContain(email);
    expect(output).not.toMatch(/params:/i);
    expect(output).not.toMatch(/reset-password:/);
  });

  it('keeps request values out of the app error log', async () => {
    const email = `dbfail2-${Date.now()}@bas.lu`;
    const signUp = await h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: jsonHeaders,
      payload: { email, password: 'correct horse battery', name: 'Tester', callbackURL: '/' },
    });
    expect(signUp.statusCode).toBe(200);
    const mail = h.outbox.findLast((m) => m.to === email);
    const link = /https?:\/\/\S+verify-email\?\S+/.exec(mail?.text ?? '')?.[0] ?? '';
    const url = new URL(link);
    const verify = await h.app.inject(url.pathname + url.search);
    const cookie = verify.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    lines.length = 0;
    await h.database.pool.query('alter table tanks rename to tanks_gone');
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/tanks',
        headers: { ...jsonHeaders, cookie },
        payload: { name: 'SECRETTANKNAME', biome: 'freshwater' },
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await h.database.pool.query('alter table tanks_gone rename to tanks');
    }
    const log = lines.join('');
    expect(log).toContain('unhandled error');
    expect(log).not.toContain('SECRETTANKNAME');
    expect(log).not.toMatch(/params:/i);
  });
});
