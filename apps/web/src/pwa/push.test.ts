import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../ui/api';
import {
  browserPushHost,
  decodeServerKey,
  isOwnedByAnotherAccount,
  PushSetupError,
  removeThisDevice,
  subscribeThisDevice,
  type PushApi,
  type PushHost,
  type PushSubscriptionLike,
} from './push';

const SERVER_KEY =
  'BNsd-_8AAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_QEE';
const P256DH = 'B'.padEnd(87, 'x');
const AUTH = 'a'.repeat(22);

class FakeSubscription implements PushSubscriptionLike {
  unsubscribed = false;
  readonly options: { applicationServerKey: ArrayBuffer | null; userVisibleOnly: boolean };
  constructor(
    readonly endpoint: string,
    applicationServerKey: ArrayBuffer | null = null,
  ) {
    this.options = { applicationServerKey, userVisibleOnly: true };
  }
  toJSON() {
    return { endpoint: this.endpoint, keys: { p256dh: P256DH, auth: AUTH } };
  }
  async unsubscribe() {
    this.unsubscribed = true;
    return true;
  }
}

function makeHost(
  permission: NotificationPermission,
  options: { existing?: FakeSubscription; subscribeFails?: boolean } = {},
) {
  let existing: FakeSubscription | null = options.existing ?? null;
  const created: FakeSubscription[] = [];
  const requestPermission = vi.fn(async (): Promise<NotificationPermission> => 'granted');
  const host: PushHost = {
    permission: () => permission,
    requestPermission,
    pushManager: async () => ({
      getSubscription: async () => (existing && !existing.unsubscribed ? existing : null),
      subscribe: async () => {
        if (options.subscribeFails) throw new Error('push service unreachable');
        const next = new FakeSubscription(`https://fcm.googleapis.com/fcm/send/${created.length}`);
        created.push(next);
        existing = next;
        return next;
      },
    }),
  };
  return { host, created, requestPermission };
}

const conflict = (message: string) => new ApiRequestError(409, 'conflict', message);

function makeApi(
  failures: ApiRequestError[] = [],
  server: { rows?: string[]; foreign?: string[] } = {},
): PushApi & { added: string[]; rows: Set<string> } {
  const added: string[] = [];
  const rows = new Set(server.rows ?? []);
  const foreign = new Set(server.foreign ?? []);
  return {
    added,
    rows,
    reminders: vi.fn(async () => ({ subscriptions: rows.size })),
    addPushSubscription: vi.fn(async (sub) => {
      const failure = failures.shift();
      if (failure) throw failure;
      added.push(sub.endpoint);
      rows.add(sub.endpoint);
    }),
    removePushSubscription: vi.fn(async (endpoint) => {
      if (!foreign.has(endpoint)) rows.delete(endpoint);
    }),
  };
}

describe('decodeServerKey', () => {
  it('decodes unpadded base64url to the 65-byte uncompressed point', () => {
    const bytes = decodeServerKey(SERVER_KEY);
    expect(bytes[0]).toBe(0x04);
    expect(bytes[1]).toBe(0xdb);
    expect(bytes[2]).toBe(0x1d);
  });
});

describe('browserPushHost', () => {
  const base = {
    isSecureContext: true,
    navigator: { serviceWorker: {} as ServiceWorkerContainer },
  };

  it('is null without a secure context, a worker, Notification or PushManager', () => {
    const notification = { permission: 'default' } as unknown as typeof Notification;
    expect(
      browserPushHost({ ...base, Notification: notification, PushManager: Object }),
    ).not.toBeNull();
    expect(
      browserPushHost({
        ...base,
        isSecureContext: false,
        Notification: notification,
        PushManager: Object,
      }),
    ).toBeNull();
    expect(
      browserPushHost({
        isSecureContext: true,
        navigator: {} as Navigator,
        Notification: notification,
        PushManager: Object,
      }),
    ).toBeNull();
    expect(browserPushHost({ ...base, PushManager: Object })).toBeNull();
    expect(browserPushHost({ ...base, Notification: notification })).toBeNull();
  });

  it('says so when the worker never becomes ready', async () => {
    const host = browserPushHost(
      {
        isSecureContext: true,
        navigator: {
          serviceWorker: {
            ready: new Promise(() => undefined),
          } as unknown as ServiceWorkerContainer,
        },
        Notification: { permission: 'default' } as unknown as typeof Notification,
        PushManager: Object,
      },
      5,
    );
    await expect(host?.pushManager()).rejects.toThrow(/background worker is not running/);
  });
});

describe('subscribeThisDevice', () => {
  it('asks for permission, subscribes and registers the endpoint', async () => {
    const { host, requestPermission, created } = makeHost('default');
    const api = makeApi();
    const endpoint = await subscribeThisDevice(host, api, SERVER_KEY);
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(endpoint).toBe(created[0]?.endpoint);
    expect(api.added).toEqual([endpoint]);
  });

  it('does not prompt again once permission is granted', async () => {
    const { host, requestPermission } = makeHost('granted');
    await subscribeThisDevice(host, makeApi(), SERVER_KEY);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('explains a blocked site and never subscribes', async () => {
    const { host, created } = makeHost('denied');
    await expect(subscribeThisDevice(host, makeApi(), SERVER_KEY)).rejects.toThrow(/blocked/);
    expect(created).toHaveLength(0);
  });

  it('explains a dismissed prompt', async () => {
    const { host, requestPermission } = makeHost('default');
    requestPermission.mockResolvedValueOnce('default');
    await expect(subscribeThisDevice(host, makeApi(), SERVER_KEY)).rejects.toThrow(/not granted/);
  });

  it('reuses an existing subscription for the same key', async () => {
    const existing = new FakeSubscription('https://fcm.googleapis.com/fcm/send/old');
    const { host, created } = makeHost('granted', { existing });
    const api = makeApi();
    await subscribeThisDevice(host, api, SERVER_KEY);
    expect(created).toHaveLength(0);
    expect(api.added).toEqual([existing.endpoint]);
  });

  it('replaces a subscription made for a different server key', async () => {
    const existing = new FakeSubscription(
      'https://fcm.googleapis.com/fcm/send/old',
      new Uint8Array([4, 1, 2, 3]).buffer,
    );
    const { host, created } = makeHost('granted', { existing });
    await subscribeThisDevice(host, makeApi(), SERVER_KEY);
    expect(existing.unsubscribed).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('reports a browser that cannot subscribe', async () => {
    const { host } = makeHost('granted', { subscribeFails: true });
    const error = await subscribeThisDevice(host, makeApi(), SERVER_KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushSetupError);
    expect((error as Error).message).toMatch(/push service unreachable/);
  });

  it('drops a new browser subscription when the server rejects it, and rethrows', async () => {
    const { host, created } = makeHost('granted');
    const api = makeApi([conflict('At most 10 devices can get push.')]);
    await expect(subscribeThisDevice(host, api, SERVER_KEY)).rejects.toThrow(/At most 10/);
    expect(created[0]?.unsubscribed).toBe(true);
  });

  it('keeps a pre-existing subscription when the server is down', async () => {
    const existing = new FakeSubscription('https://fcm.googleapis.com/fcm/send/old');
    const { host } = makeHost('granted', { existing });
    const api = makeApi([new ApiRequestError(0, 'network', 'offline')]);
    await expect(subscribeThisDevice(host, api, SERVER_KEY)).rejects.toThrow('offline');
    expect(existing.unsubscribed).toBe(false);
  });

  it('takes a fresh endpoint when another account owns this one', async () => {
    const existing = new FakeSubscription('https://fcm.googleapis.com/fcm/send/shared');
    const { host, created } = makeHost('granted', { existing });
    const api = makeApi([conflict('This device is already registered to another account.')]);
    const endpoint = await subscribeThisDevice(host, api, SERVER_KEY);
    expect(existing.unsubscribed).toBe(true);
    expect(endpoint).toBe(created[0]?.endpoint);
    expect(api.added).toEqual([endpoint]);
  });

  it('explains clearly when the fresh endpoint is refused too', async () => {
    const existing = new FakeSubscription('https://fcm.googleapis.com/fcm/send/shared');
    const { host, created } = makeHost('granted', { existing });
    const owned = 'This device is already registered to another account.';
    const api = makeApi([conflict(owned), conflict(owned)]);
    await expect(subscribeThisDevice(host, api, SERVER_KEY)).rejects.toThrow(/another account/);
    expect(created[0]?.unsubscribed).toBe(true);
  });

  it('explains when the browser cannot resubscribe after a handover conflict', async () => {
    const existing = new FakeSubscription('https://fcm.googleapis.com/fcm/send/shared');
    const { host } = makeHost('granted', { existing, subscribeFails: true });
    const api = makeApi([conflict('This device is already registered to another account.')]);
    await expect(subscribeThisDevice(host, api, SERVER_KEY)).rejects.toThrow(
      /browser notification settings/,
    );
  });
});

describe('isOwnedByAnotherAccount', () => {
  it('tells the shared-browser conflict from the device limit', () => {
    expect(
      isOwnedByAnotherAccount(conflict('This device is already registered to another account.')),
    ).toBe(true);
    expect(isOwnedByAnotherAccount(conflict('At most 10 devices can get push.'))).toBe(false);
    expect(isOwnedByAnotherAccount(new Error('another account'))).toBe(false);
  });
});

describe('removeThisDevice', () => {
  const endpoint = 'https://fcm.googleapis.com/fcm/send/mine';

  it('removes the row on the server, then unsubscribes the browser', async () => {
    const existing = new FakeSubscription(endpoint);
    const { host } = makeHost('granted', { existing });
    const api = makeApi([], { rows: [endpoint, 'https://fcm.googleapis.com/fcm/send/other'] });
    expect(await removeThisDevice(host, api)).toBe('removed');
    expect(api.removePushSubscription).toHaveBeenCalledWith(endpoint);
    expect(existing.unsubscribed).toBe(true);
  });

  it("leaves another account's subscription alone on a shared browser", async () => {
    const existing = new FakeSubscription(endpoint);
    const { host } = makeHost('granted', { existing });
    const api = makeApi([], { rows: [endpoint], foreign: [endpoint] });
    expect(await removeThisDevice(host, api)).toBe('not-registered');
    expect(existing.unsubscribed).toBe(false);
  });

  it('keeps the browser subscription when the server call fails', async () => {
    const existing = new FakeSubscription(endpoint);
    const { host } = makeHost('granted', { existing });
    const api = makeApi([], { rows: [endpoint] });
    vi.mocked(api.removePushSubscription).mockRejectedValueOnce(new Error('down'));
    await expect(removeThisDevice(host, api)).rejects.toThrow('down');
    expect(existing.unsubscribed).toBe(false);
  });

  it('turns a browser refusal to unsubscribe into a clear message', async () => {
    const existing = new FakeSubscription(endpoint);
    vi.spyOn(existing, 'unsubscribe').mockRejectedValueOnce(new Error('InvalidStateError'));
    const { host } = makeHost('granted', { existing });
    const api = makeApi([], { rows: [endpoint] });
    await expect(removeThisDevice(host, api)).rejects.toBeInstanceOf(PushSetupError);
  });

  it('does nothing without a subscription', async () => {
    const { host } = makeHost('granted');
    const api = makeApi();
    expect(await removeThisDevice(host, api)).toBe('none');
    expect(api.removePushSubscription).not.toHaveBeenCalled();
  });
});

describe('subscribeThisDevice cleanup', () => {
  it('deletes the old server row when the server key changed', async () => {
    const old = 'https://fcm.googleapis.com/fcm/send/old';
    const existing = new FakeSubscription(old, new Uint8Array([4, 1, 2, 3]).buffer);
    const { host } = makeHost('granted', { existing });
    const api = makeApi([], { rows: [old] });
    await subscribeThisDevice(host, api, SERVER_KEY);
    expect(api.rows.has(old)).toBe(false);
    expect(api.rows.size).toBe(1);
  });

  it('keeps a new subscription when the response was lost, so a retry matches the stored row', async () => {
    const { host, created } = makeHost('granted');
    const api = makeApi([new ApiRequestError(0, 'network', 'Could not reach the server.')]);
    await expect(subscribeThisDevice(host, api, SERVER_KEY)).rejects.toMatchObject({ status: 0 });
    expect(created[0]?.unsubscribed).toBe(false);
  });
});
