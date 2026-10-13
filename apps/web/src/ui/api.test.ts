import type { DecorLayout } from '@aquarium/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, ClientValidationError, createApiClient } from './api';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const user = {
  id: 'u1',
  email: 'a@bas.lu',
  name: 'Ann',
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('api client', () => {
  it('sends sign-up with the verification callback and never calls the server on invalid input', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ user }));
    const api = createApiClient(fetcher);
    await api.signUp({ email: 'a@bas.lu', password: 'correct horse battery', name: ' Ann ' });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/sign-up/email');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'a@bas.lu',
      password: 'correct horse battery',
      name: 'Ann',
      callbackURL: '/verify-email',
    });

    const bad = createApiClient(fetcher);
    fetcher.mockClear();
    const error = await bad.signUp({ email: 'nope', password: 'short', name: '' }).catch((e) => e);
    expect(error).toBeInstanceOf(ClientValidationError);
    expect(Object.keys((error as ClientValidationError).fields).sort()).toEqual([
      'email',
      'name',
      'password',
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends the verification callback on sign-in so the re-sent mail lands on the landing page', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({}));
    await createApiClient(fetcher).signIn({ email: 'a@bas.lu', password: 'x' });
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ callbackURL: '/verify-email' });
  });

  it('exposes retry-after on rate limited responses', async () => {
    const res = () =>
      new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Slow' } }), {
        status: 429,
        headers: { 'retry-after': '42' },
      });
    const error = (await createApiClient(vi.fn().mockResolvedValue(res()))
      .resendVerification('a@bas.lu')
      .catch((e) => e)) as ApiRequestError;
    expect(error.retryAfterSeconds).toBe(42);
  });

  it('maps Better Auth unverified-email errors to email_not_verified', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(json({ code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' }, 403));
    const error = await createApiClient(fetcher)
      .signIn({ email: 'a@bas.lu', password: 'x' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 403, code: 'email_not_verified' });
  });

  it('reads our error envelope including field issues', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json(
        {
          error: {
            code: 'validation_failed',
            message: 'Request validation failed.',
            issues: [{ path: ['password'], message: 'too weak' }],
          },
        },
        400,
      ),
    );
    const error = (await createApiClient(fetcher)
      .signIn({ email: 'a@bas.lu', password: 'x' })
      .catch((e) => e)) as ApiRequestError;
    expect(error.code).toBe('validation_failed');
    expect(error.fields).toEqual({ password: 'too weak' });
  });

  it('reports rate limiting and non-JSON failures with a usable message', async () => {
    const limited = createApiClient(
      vi
        .fn()
        .mockResolvedValue(json({ error: { code: 'rate_limited', message: 'Slow down' } }, 429)),
    );
    await expect(limited.signOut()).rejects.toMatchObject({ code: 'rate_limited' });
    const html = createApiClient(
      vi.fn().mockResolvedValue(new Response('<html>', { status: 502 })),
    );
    await expect(html.signOut()).rejects.toMatchObject({
      code: 'internal',
      message: 'Request failed (502).',
    });
  });

  it('turns a network failure into a typed error', async () => {
    const api = createApiClient(vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api.me()).rejects.toMatchObject({ code: 'network', status: 0 });
  });

  it('me() returns null when signed out and validates the user otherwise', async () => {
    expect(
      await createApiClient(
        vi.fn().mockResolvedValue(json({ error: { code: 'unauthenticated', message: 'x' } }, 401)),
      ).me(),
    ).toBeNull();
    expect(await createApiClient(vi.fn().mockResolvedValue(json(user))).me()).toEqual(user);
    await expect(
      createApiClient(vi.fn().mockResolvedValue(json({ id: 1 }))).me(),
    ).rejects.toMatchObject({ code: 'unexpected_response' });
  });

  it('lists and revokes sessions', async () => {
    const session = {
      id: 's1',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-02-01T00:00:00.000Z',
      userAgent: null,
      current: true,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json([session]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient(fetcher);
    expect(await api.sessions()).toEqual([session]);
    await api.revokeSession('s1');
    const [url, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/sessions/revoke');
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: 's1' });
  });

  it('rejects a bad email before asking for a verification mail', async () => {
    const fetcher = vi.fn();
    await expect(createApiClient(fetcher).resendVerification('nope')).rejects.toBeInstanceOf(
      ClientValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('saves a decor layout with PATCH and returns the tank the server stored', async () => {
    const layout: DecorLayout = [
      { assetId: 'boulder-01', position: [0.1, 0.05, -0.2], rotationY: 0.5, scale: 1 },
    ];
    const tank = {
      id: '00000000-0000-4000-8000-00000000000a',
      name: 'Home',
      biome: 'freshwater',
      decorLayout: layout,
      water: { ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 0 },
      lastTickAt: '2026-02-01T00:00:00.000Z',
      fish: [],
      memorials: [],
    };
    const fetcher = vi.fn().mockResolvedValue(json(tank));
    const saved = await createApiClient(fetcher).saveDecorLayout(tank.id, layout);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/tanks/${tank.id}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ decorLayout: layout });
    expect(saved.decorLayout).toEqual(layout);
  });

  it('refuses to send a layout the server would reject', async () => {
    const fetcher = vi.fn();
    const outside = [
      {
        assetId: 'boulder-01',
        position: [9, 0, 0] as [number, number, number],
        rotationY: 0,
        scale: 1,
      },
    ];
    await expect(createApiClient(fetcher).saveDecorLayout('t', outside)).rejects.toBeInstanceOf(
      ClientValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
