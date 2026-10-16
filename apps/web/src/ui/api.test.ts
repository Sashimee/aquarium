import { DEFAULT_EQUIPMENT, NEW_TANK_CHEMISTRY, type DecorLayout } from '@aquarium/shared';
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
      water: { ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 0 },
      lastTickAt: '2026-02-01T00:00:00.000Z',
      chemistry: NEW_TANK_CHEMISTRY,
      equipment: DEFAULT_EQUIPMENT,
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
