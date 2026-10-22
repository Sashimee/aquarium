import { DEFAULT_EQUIPMENT, newTankChemistry, type DecorLayout } from '@aquarium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiRequestError,
  ApiTimeoutError,
  ClientValidationError,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  SLOW_REQUEST_TIMEOUT_MS,
  TOTAL_TIMEOUT_FACTOR,
  createApiClient,
} from './api';
import { TANK_A, tankFixture } from '../sync/fixtures';

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
      decorEdited: true,
      backgroundId: 'bg-fw-planted-stream',
      water: { ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 0 },
      lastTickAt: '2026-02-01T00:00:00.000Z',
      chemistry: newTankChemistry('freshwater'),
      size: 'standard',
      quarantine: false,
      shared: false,
      inGallery: false,
      acceptsGifts: false,
      shareToken: null,
      equipment: DEFAULT_EQUIPMENT,
      co2OwnedTier: 0,
      recentVisitDays: 0,
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

  it('patches only the background id, and refuses one the contract does not know', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({}));
    await createApiClient(fetcher)
      .saveBackground('t', 'bg-reef-deep-blue')
      .catch(() => undefined);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/tanks/t');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ backgroundId: 'bg-reef-deep-blue' });
    await expect(
      createApiClient(vi.fn()).saveBackground('t', 'bg-nope' as never),
    ).rejects.toBeInstanceOf(ClientValidationError);
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

  it('asks for a reset link that lands on an app route', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ status: true }));
    await createApiClient(fetcher).requestPasswordReset('a@bas.lu');
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/request-password-reset');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'a@bas.lu',
      redirectTo: '/reset-password',
    });
    await expect(createApiClient(fetcher).requestPasswordReset('nope')).rejects.toBeInstanceOf(
      ClientValidationError,
    );
  });

  it('posts the token and a valid new password, and rejects a short one locally', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ status: true }));
    await createApiClient(fetcher).resetPassword('tok', 'correct horse battery');
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/reset-password');
    expect(JSON.parse(init.body as string)).toEqual({
      token: 'tok',
      newPassword: 'correct horse battery',
    });
    fetcher.mockClear();
    await expect(createApiClient(fetcher).resetPassword('tok', 'short')).rejects.toBeInstanceOf(
      ClientValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('explains the length limit when a new password is too long', async () => {
    const fetcher = vi.fn();
    await expect(
      createApiClient(fetcher).resetPassword('tok', 'a'.repeat(129)),
    ).rejects.toMatchObject({ fields: { password: 'Use at most 128 characters.' } });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('api client sharing', () => {
  const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_-';
  const state = { reactions: { heart: 1, star: 0, wow: 0 }, myReaction: 'heart' };

  it('posts share and rotate, deletes to revoke, and reads the issued token', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(tankFixture({ shared: true, shareToken: TOKEN })))
      .mockResolvedValueOnce(json(tankFixture({ shared: true, shareToken: TOKEN })))
      .mockResolvedValueOnce(json(tankFixture({ shared: false })));
    const api = createApiClient(fetcher);
    expect((await api.shareTank(TANK_A)).shareToken).toBe(TOKEN);
    await api.rotateShare(TANK_A);
    expect((await api.revokeShare(TANK_A)).shared).toBe(false);
    const calls = fetcher.mock.calls as [string, RequestInit][];
    expect(calls.map(([url, init]) => [init.method, url])).toEqual([
      ['POST', `/api/tanks/${TANK_A}/share`],
      ['POST', `/api/tanks/${TANK_A}/share/rotate`],
      ['DELETE', `/api/tanks/${TANK_A}/share`],
    ]);
  });

  it('puts the gallery toggle, validating the body', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(tankFixture({ shared: true, inGallery: true })));
    const api = createApiClient(fetcher);
    expect((await api.setGallery(TANK_A, true)).inGallery).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/tanks/${TANK_A}/gallery`);
    expect(init).toMatchObject({ method: 'PUT', body: '{"listed":true}' });
    await expect(api.setGallery(TANK_A, 'yes' as never)).rejects.toBeInstanceOf(
      ClientValidationError,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads the gallery page and sends the vote on the vote route', async () => {
    const week = { weekStart: '2026-02-02T00:00:00.000Z', weekEnd: '2026-02-09T00:00:00.000Z' };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ ...week, total: 0, entries: [], myVote: null }))
      .mockResolvedValueOnce(json({ ...week, myVote: TANK_A }))
      .mockResolvedValueOnce(json({ ...week, myVote: null }));
    const api = createApiClient(fetcher);
    expect((await api.gallery({ limit: 24, offset: 24 })).total).toBe(0);
    expect((await api.castVote(TANK_A)).myVote).toBe(TANK_A);
    expect((await api.clearVote()).myVote).toBeNull();
    const calls = fetcher.mock.calls as [string, RequestInit | undefined][];
    expect(calls[0]?.[0]).toBe('/api/gallery?limit=24&offset=24');
    expect(calls[1]?.[0]).toBe('/api/gallery/vote');
    expect(calls[1]?.[1]).toMatchObject({ method: 'PUT', body: `{"tankId":"${TANK_A}"}` });
    expect(calls[2]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('turns vote refusals into typed errors and rejects a bad tank id locally', async () => {
    const reply = (status: number, code: string, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify({ error: { code, message: 'nope' } }), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(reply(429, 'rate_limited', { 'retry-after': '30' }))
      .mockResolvedValueOnce(reply(403, 'own_tank'));
    const api = createApiClient(fetcher);
    await expect(api.castVote(TANK_A)).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 30,
    });
    await expect(api.castVote(TANK_A)).rejects.toMatchObject({ status: 403, code: 'own_tank' });
    await expect(api.castVote('nope')).rejects.toBeInstanceOf(ClientValidationError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('sets and clears a reaction on the public path and reads the new state', async () => {
    const fetcher = vi.fn().mockImplementation(async () => json(state));
    const api = createApiClient(fetcher);
    expect(await api.setReaction(TOKEN, 'heart')).toEqual(state);
    await api.clearReaction(TOKEN);
    const calls = fetcher.mock.calls as [string, RequestInit][];
    expect(calls[0]?.[0]).toBe(`/api/public/${TOKEN}/reaction`);
    expect(calls[0]?.[1]).toMatchObject({ method: 'PUT', body: '{"kind":"heart"}' });
    expect(calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('rejects an unknown reaction without calling the server', async () => {
    const fetcher = vi.fn();
    await expect(
      createApiClient(fetcher).setReaction(TOKEN, 'thumbs' as never),
    ).rejects.toBeInstanceOf(ClientValidationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('turns 404, 429 and 401 into errors a viewer can act on', async () => {
    const reply = (status: number, code: string, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify({ error: { code, message: 'nope' } }), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(reply(404, 'not_found'))
      .mockResolvedValueOnce(reply(429, 'rate_limited', { 'retry-after': '17' }))
      .mockResolvedValueOnce(reply(401, 'unauthenticated'));
    const api = createApiClient(fetcher);
    await expect(api.publicTank(TOKEN)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(api.publicTank(TOKEN)).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 17,
    });
    await expect(api.setReaction(TOKEN, 'star')).rejects.toMatchObject({ status: 401 });
  });

  it('carries the conflict reason and posts a move to the fish route', async () => {
    const refusal = new Response(
      JSON.stringify({ error: { code: 'conflict', message: 'Full.', reason: 'tank_full' } }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
    const fetcher = vi.fn().mockResolvedValue(refusal);
    const request = { toTankId: TANK_A, idempotencyKey: 'move-key-0001' };
    await expect(
      createApiClient(fetcher).moveFish(TANK_A, 'fish-1', request),
    ).rejects.toMatchObject({ status: 409, reason: 'tank_full' });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/tanks/${TANK_A}/fish/fish-1/move`);
    expect(JSON.parse(init.body as string)).toEqual(request);
  });

  it('keeps the coral_no_room reason of a refused frag through the error parser', async () => {
    const refusal = new Response(
      JSON.stringify({
        error: { code: 'conflict', message: 'No room.', reason: 'coral_no_room' },
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
    const request = { coralKey: 's7', idempotencyKey: 'frag-key-0002' };
    await expect(
      createApiClient(vi.fn().mockResolvedValue(refusal)).fragCoral(TANK_A, request),
    ).rejects.toMatchObject({ status: 409, reason: 'coral_no_room' });
  });

  it('patches acceptsGifts on the tank', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(tankFixture({ acceptsGifts: true })));
    await createApiClient(fetcher).setAcceptsGifts(TANK_A, true);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/tanks/${TANK_A}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ acceptsGifts: true });
  });

  it('carries the gifts_closed reason of a refused offer and posts to the gifts route', async () => {
    const refusal = new Response(
      JSON.stringify({ error: { code: 'conflict', message: 'Closed.', reason: 'gifts_closed' } }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
    const fetcher = vi.fn().mockResolvedValue(refusal);
    const request = {
      fromTankId: TANK_A,
      fishId: '10000000-0000-4000-8000-000000000001',
      toHandle: 'reef_fan',
      idempotencyKey: 'gift-key-0001',
    };
    await expect(createApiClient(fetcher).createGift(request)).rejects.toMatchObject({
      status: 409,
      reason: 'gifts_closed',
    });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/gifts');
    expect(JSON.parse(init.body as string)).toMatchObject({
      toHandle: 'reef_fan',
      wantsReturn: false,
    });
  });

  it('refuses a bad handle before sending anything', async () => {
    const fetcher = vi.fn();
    await expect(
      createApiClient(fetcher).createGift({
        fromTankId: TANK_A,
        fishId: '10000000-0000-4000-8000-000000000001',
        toHandle: 'X',
        idempotencyKey: 'gift-key-0001',
      }),
    ).rejects.toBeInstanceOf(ClientValidationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('posts a trim to the plants route and refuses a size the server would not read', async () => {
    const refusal = new Response(
      JSON.stringify({
        error: { code: 'conflict', message: 'Not grown.', reason: 'plant_not_grown' },
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
    const fetcher = vi.fn().mockResolvedValue(refusal);
    const request = { plantKey: 's7', size: 1, idempotencyKey: 'trim-key-0001' };
    await expect(createApiClient(fetcher).trimPlant(TANK_A, request)).rejects.toMatchObject({
      status: 409,
      reason: 'plant_not_grown',
    });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/tanks/${TANK_A}/plants/trim`);
    expect(JSON.parse(init.body as string)).toEqual(request);
    await expect(
      createApiClient(fetcher).trimPlant(TANK_A, { ...request, size: -1 }),
    ).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('posts a frag to the corals route and refuses a request the server would not read', async () => {
    const refusal = new Response(
      JSON.stringify({
        error: { code: 'conflict', message: 'Too bleached.', reason: 'coral_bleached' },
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
    const fetcher = vi.fn().mockResolvedValue(refusal);
    const request = { coralKey: 's7', idempotencyKey: 'frag-key-0001' };
    await expect(createApiClient(fetcher).fragCoral(TANK_A, request)).rejects.toMatchObject({
      status: 409,
      reason: 'coral_bleached',
    });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/tanks/${TANK_A}/corals/frag`);
    expect(JSON.parse(init.body as string)).toEqual(request);
    await expect(
      createApiClient(fetcher).fragCoral(TANK_A, { ...request, coralKey: '' }),
    ).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses a public tank response it cannot read', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ name: 'x' }));
    await expect(createApiClient(fetcher).publicTank(TOKEN)).rejects.toMatchObject({
      code: 'unexpected_response',
    });
  });
});

describe('api client timeouts', () => {
  const neverResolves = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });

  async function isSettled(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    void promise.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    return settled;
  }

  it('rejects a stalled request with a typed timeout error, not a network error', async () => {
    vi.useFakeTimers();
    try {
      const result = createApiClient(neverResolves)
        .tanks()
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
      expect(await isSettled(result)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await result;
      expect(error).toBeInstanceOf(ApiTimeoutError);
      expect(error).toBeInstanceOf(ApiRequestError);
      expect((error as ApiRequestError).code).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the next request run after one times out', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockImplementationOnce(neverResolves).mockResolvedValueOnce(json([]));
      const api = createApiClient(fetcher);
      const first = api.tanks().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      expect(await first).toBeInstanceOf(ApiTimeoutError);
      await expect(api.tanks()).resolves.toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a timed-out request on its own', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockImplementation(neverResolves);
      const result = createApiClient(fetcher)
        .tanks()
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 10);
      await result;
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the data export a longer allowance', async () => {
    vi.useFakeTimers();
    try {
      const result = createApiClient(neverResolves)
        .exportData()
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      expect(await isSettled(result)).toBe(false);
      await vi.advanceTimersByTimeAsync(SLOW_REQUEST_TIMEOUT_MS - REQUEST_TIMEOUT_MS);
      expect(await result).toBeInstanceOf(ApiTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still honours a caller abort and reports it as a cancellation', async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      const result = createApiClient(neverResolves, { signal: caller.signal })
        .tanks()
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10);
      caller.abort();
      const error = await result;
      expect(error).not.toBeInstanceOf(ApiTimeoutError);
      expect(error).toMatchObject({ code: 'network', message: 'The request was cancelled.' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a body that stalls after the headers and reports a timeout', async () => {
    vi.useFakeTimers();
    try {
      const stalled = () =>
        Promise.resolve(
          new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      const result = createApiClient(stalled)
        .tanks()
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      expect(await result).toBeInstanceOf(ApiTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no timer behind after a success or a network failure', async () => {
    vi.useFakeTimers();
    try {
      await createApiClient(vi.fn().mockResolvedValue(json([]))).tanks();
      expect(vi.getTimerCount()).toBe(0);
      await createApiClient(vi.fn().mockRejectedValue(new TypeError('offline')))
        .tanks()
        .catch(() => undefined);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a body that is still arriving alive past the request timeout', async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      const slow = () => {
        const parts = ['[', ']'];
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                const part = parts.shift();
                if (part === undefined) return controller.close();
                await new Promise((resolve) => setTimeout(resolve, REQUEST_TIMEOUT_MS - 1000));
                controller.enqueue(encoder.encode(part));
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      };
      const result = createApiClient(slow).tanks();
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
      await expect(result).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a body that trickles in forever once the overall deadline passes', async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      const trickle = () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                await new Promise((resolve) => setTimeout(resolve, REQUEST_TIMEOUT_MS - 1000));
                controller.enqueue(encoder.encode(' '));
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      const result = createApiClient(trickle)
        .tanks()
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * TOTAL_TIMEOUT_FACTOR);
      expect(await result).toMatchObject({
        timeoutMs: REQUEST_TIMEOUT_MS * TOTAL_TIMEOUT_FACTOR,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a body that grows past the size cap', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const huge = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              sent += 1;
              controller.enqueue(chunk);
            },
          }),
          { status: 200 },
        ),
      );
    await expect(createApiClient(huge).tanks()).rejects.toMatchObject({
      code: 'unexpected_response',
    });
    expect(sent).toBeLessThanOrEqual(MAX_RESPONSE_BYTES / chunk.byteLength + 2);
  });

  it('rejects a response whose content-length is over the cap without reading it', async () => {
    const declared = () =>
      Promise.resolve(
        new Response('[]', {
          status: 200,
          headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
        }),
      );
    await expect(createApiClient(declared).tanks()).rejects.toMatchObject({
      code: 'unexpected_response',
    });
  });

  describe('without AbortSignal.any', () => {
    const original = AbortSignal.any;
    beforeEach(() => {
      Reflect.deleteProperty(AbortSignal, 'any');
    });
    afterEach(() => {
      AbortSignal.any = original;
    });

    it('works with no caller signal', async () => {
      await expect(createApiClient(vi.fn().mockResolvedValue(json([]))).tanks()).resolves.toEqual(
        [],
      );
    });

    it('removes the listeners it put on the caller signal when the request ends', async () => {
      const caller = new AbortController();
      const added = vi.spyOn(caller.signal, 'addEventListener');
      const removed = vi.spyOn(caller.signal, 'removeEventListener');
      await createApiClient(vi.fn().mockResolvedValue(json([])), { signal: caller.signal }).tanks();
      expect(added).toHaveBeenCalled();
      for (const [type, listener] of added.mock.calls) {
        expect(removed).toHaveBeenCalledWith(type, listener);
      }
    });

    it('still honours a caller abort and the timeout when signals are combined by hand', async () => {
      vi.useFakeTimers();
      try {
        const caller = new AbortController();
        const aborted = createApiClient(neverResolves, { signal: caller.signal })
          .tanks()
          .catch((e: unknown) => e);
        caller.abort();
        expect(await aborted).toMatchObject({ code: 'network' });

        const timedOut = createApiClient(neverResolves, { signal: new AbortController().signal })
          .tanks()
          .catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
        expect(await timedOut).toBeInstanceOf(ApiTimeoutError);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('api.replay', () => {
  const since = '2026-10-18T10:00:00.000Z';

  it('serialises since, limit, until and cursor and encodes the tank id', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ events: [], nextCursor: null }));
    const api = createApiClient(fetcher);
    const ctl = new AbortController();
    await api.replay(
      'a/b',
      { since, until: '2026-10-18T12:00:00.000Z', cursor: 'abc_-1', limit: 50 },
      ctl.signal,
    );
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith('/api/tanks/a%2Fb/replay?')).toBe(true);
    const params = new URL(url, 'http://x').searchParams;
    expect(Object.fromEntries(params)).toEqual({
      since,
      until: '2026-10-18T12:00:00.000Z',
      cursor: 'abc_-1',
      limit: '50',
    });
    expect(init.signal?.aborted).toBe(false);
    ctl.abort();
    expect(init.signal?.aborted).toBe(true);
  });

  it('defaults the limit, omits absent params and rejects a bad query before fetching', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ events: [], nextCursor: null }));
    const api = createApiClient(fetcher);
    await api.replay(TANK_A, { since });
    const [url] = fetcher.mock.calls[0] as [string];
    expect(Object.fromEntries(new URL(url, 'http://x').searchParams)).toEqual({
      since,
      limit: '200',
    });
    fetcher.mockClear();
    await expect(api.replay(TANK_A, { since: 'yesterday' })).rejects.toBeInstanceOf(
      ClientValidationError,
    );
    await expect(api.replay(TANK_A, { since, cursor: 'no good!' })).rejects.toBeInstanceOf(
      ClientValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('turns an error response into an ApiRequestError and rejects a malformed body', async () => {
    const api = createApiClient(
      vi.fn().mockResolvedValue(json({ error: 'rate_limited', message: 'slow down' }, 429)),
    );
    await expect(api.replay(TANK_A, { since })).rejects.toMatchObject({ status: 429 });
    const odd = createApiClient(vi.fn().mockResolvedValue(json({ events: 'no' })));
    await expect(odd.replay(TANK_A, { since })).rejects.toBeInstanceOf(ApiRequestError);
  });
});

describe('api client Pearls contract', () => {
  const KEY = 'key-0123456789abcdef';

  it('sends the stage and the idempotency key when adding a fish', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(tankFixture()));
    await createApiClient(fetcher).addFish(TANK_A, {
      species: 'neon-tetra',
      name: 'Dot',
      stage: 'adult',
      idempotencyKey: KEY,
    });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/tanks/${TANK_A}/fish`);
    expect(JSON.parse(init.body as string)).toMatchObject({
      species: 'neon-tetra',
      stage: 'adult',
      idempotencyKey: KEY,
    });
  });

  it('refuses bottled bacteria without a key before calling the server', async () => {
    const fetcher = vi.fn();
    const error = await createApiClient(fetcher)
      // @ts-expect-error the key is required by the contract; this checks schema validation of untyped input
      .care(TANK_A, { type: 'bottled_bacteria' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ClientValidationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends bottled bacteria with its key', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(tankFixture()));
    await createApiClient(fetcher).care(TANK_A, { type: 'bottled_bacteria', idempotencyKey: KEY });
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      type: 'bottled_bacteria',
      idempotencyKey: KEY,
    });
  });

  it('saves the lamp schedule with a PATCH carrying only the light', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(tankFixture()));
    await createApiClient(fetcher).saveLight(TANK_A, { intensity: 0.5, onHour: 22, offHour: 6 });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/tanks/${TANK_A}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      light: { intensity: 0.5, onHour: 22, offHour: 6 },
    });
  });

  it('sets the CO2 tier with a PATCH carrying only co2, and accepts 0 for off', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(tankFixture()));
    await createApiClient(fetcher).setCo2(TANK_A, 0);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/tanks/${TANK_A}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ co2: { tier: 0 } });
  });

  it('refuses a lamp schedule whose on and off hours are equal', async () => {
    const fetcher = vi.fn();
    const error = await createApiClient(fetcher)
      .saveLight(TANK_A, { intensity: 0.5, onHour: 7, offHour: 7 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ClientValidationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the balance and the purchased items from the wallet endpoint', async () => {
    const entry = (delta: number, reason: string, itemRef: string | null, key: string) => ({
      id: crypto.randomUUID(),
      userId: 'u1',
      delta,
      reason,
      source: 'game',
      itemRef,
      idempotencyKey: key,
      createdAt: '2026-02-01T12:00:00.000Z',
    });
    const ledger = [
      entry(-25, 'purchase', 'plant:java-fern', 'key-aaaaaaaa'),
      entry(-25, 'purchase', 'plant:java-fern', 'key-bbbbbbbb'),
      entry(40, 'earn', 'earn:daily-care', 'key-cccccccc'),
      entry(500, 'grant', null, 'key-dddddddd'),
    ];
    const fetcher = vi
      .fn()
      .mockResolvedValue(json({ wallet: { balance: 420 }, ledger, owned: ['plant:java-fern'] }));
    expect(await createApiClient(fetcher).wallet()).toEqual({
      balance: 420,
      owned: ['plant:java-fern'],
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/wallet');
  });

  describe('wallet ownership from the server list', () => {
    const entry = (delta: number, reason: string, itemRef: string, key: string) => ({
      id: crypto.randomUUID(),
      userId: 'u1',
      delta,
      reason,
      source: 'game',
      itemRef,
      idempotencyKey: key,
      createdAt: '2026-02-01T12:00:00.000Z',
    });

    it('marks an item bought long before the ledger page as owned', async () => {
      const ledger = [entry(-5, 'purchase', 'plant:anubias', 'key-aaaaaaaa')];
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          json({ wallet: { balance: 10 }, ledger, owned: ['decor:boulder-01', 'plant:anubias'] }),
        );
      expect(await createApiClient(fetcher).wallet()).toEqual({
        balance: 10,
        owned: ['decor:boulder-01', 'plant:anubias'],
      });
    });

    it('owns an item refunded and bought again, and not one only refunded', async () => {
      const ledger = [
        entry(-25, 'purchase', 'plant:java-fern', 'key-aaaaaaaa'),
        entry(25, 'refund', 'plant:java-fern', 'key-bbbbbbbb'),
        entry(80, 'refund', 'decor:boulder-01', 'key-cccccccc'),
      ];
      const fetcher = vi
        .fn()
        .mockResolvedValue(json({ wallet: { balance: 10 }, ledger, owned: ['plant:java-fern'] }));
      expect(await createApiClient(fetcher).wallet()).toEqual({
        balance: 10,
        owned: ['plant:java-fern'],
      });
    });

    it('trusts an empty owned list over a purchase in the ledger page', async () => {
      const ledger = [entry(-25, 'purchase', 'plant:java-fern', 'key-aaaaaaaa')];
      const fetcher = vi
        .fn()
        .mockResolvedValue(json({ wallet: { balance: 10 }, ledger, owned: [] }));
      expect(await createApiClient(fetcher).wallet()).toEqual({
        balance: 10,
        owned: [],
      });
    });

    it('rejects a wallet response without an owned list', async () => {
      const fetcher = vi.fn().mockResolvedValue(json({ wallet: { balance: 10 }, ledger: [] }));
      await expect(createApiClient(fetcher).wallet()).rejects.toMatchObject({
        code: 'unexpected_response',
      });
    });
  });

  it('surfaces a 402 as a request error with its code', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        json({ error: { code: 'insufficient_pearls', message: 'Not enough.' } }, 402),
      );
    const error = await createApiClient(fetcher)
      .purchase({ itemRef: 'equipment:filter:2', idempotencyKey: KEY, tankId: TANK_A })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 402, code: 'insufficient_pearls' });
  });
});
