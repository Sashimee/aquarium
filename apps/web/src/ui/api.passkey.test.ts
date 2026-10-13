import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, createApiClient } from './api';

const browser = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));
vi.mock('@simplewebauthn/browser', () => browser);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('api client passkeys', () => {
  const credential = { id: 'cred', rawId: 'cred', clientExtensionResults: { x: 1 } };

  beforeEach(() => {
    browser.startRegistration.mockReset();
    browser.startAuthentication.mockReset();
  });

  it('registers a passkey from the server options and drops client extension results', async () => {
    browser.startRegistration.mockResolvedValue(credential);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ challenge: 'c' }))
      .mockResolvedValueOnce(json({}));
    await createApiClient(fetcher).addPasskey();
    expect(browser.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c' } });
    const [url, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/auth/passkey/verify-registration');
    expect(JSON.parse(init.body as string)).toEqual({ response: { id: 'cred', rawId: 'cred' } });
  });

  it('verifies a passkey sign-in with the browser assertion', async () => {
    browser.startAuthentication.mockResolvedValue(credential);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ challenge: 'c' }))
      .mockResolvedValueOnce(json({}));
    await createApiClient(fetcher).signInWithPasskey();
    const [url] = fetcher.mock.calls[1] as [string];
    expect(url).toBe('/api/auth/passkey/verify-authentication');
  });

  it('turns a cancelled prompt into a friendly error without calling verify', async () => {
    browser.startAuthentication.mockRejectedValue(new Error('The operation was cancelled'));
    const fetcher = vi.fn().mockResolvedValueOnce(json({ challenge: 'c' }));
    const error = await createApiClient(fetcher)
      .signInWithPasskey()
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).message).toContain('cancelled');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects options that are not an object before opening the browser prompt', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(null));
    await expect(createApiClient(fetcher).addPasskey()).rejects.toBeInstanceOf(ApiRequestError);
    expect(browser.startRegistration).not.toHaveBeenCalled();
  });
});
