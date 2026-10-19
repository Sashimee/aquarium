import type { PushSubscriptionRequest, RemovePushResult } from '@aquarium/shared';
import { ApiRequestError } from '../ui/api';

export const WORKER_READY_TIMEOUT_MS = 10_000;

export type PushSubscriptionLike = Pick<
  PushSubscription,
  'endpoint' | 'options' | 'toJSON' | 'unsubscribe'
>;

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: {
    userVisibleOnly: true;
    applicationServerKey: Uint8Array<ArrayBuffer>;
  }): Promise<PushSubscriptionLike>;
}

export interface PushHost {
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  pushManager(): Promise<PushManagerLike>;
}

export interface PushApi {
  addPushSubscription(subscription: PushSubscriptionRequest): Promise<void>;
  removePushSubscription(endpoint: string): Promise<RemovePushResult>;
}

export class PushSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushSetupError';
  }
}

interface PushScope {
  isSecureContext: boolean;
  navigator: Pick<Navigator, 'serviceWorker'>;
  Notification?: typeof Notification;
  PushManager?: unknown;
}

export function browserPushHost(
  scope: PushScope = window,
  timeoutMs: number = WORKER_READY_TIMEOUT_MS,
): PushHost | null {
  const { Notification: notification, PushManager: pushManagerCtor } = scope;
  if (
    !scope.isSecureContext ||
    !scope.navigator.serviceWorker ||
    !notification ||
    pushManagerCtor === undefined
  ) {
    return null;
  }
  return {
    permission: () => notification.permission,
    requestPermission: () => notification.requestPermission(),
    async pushManager() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new PushSetupError(
                'The background worker is not running, so push cannot be set up. Reload the page and try again.',
              ),
            ),
          timeoutMs,
        );
      });
      try {
        const registration = await Promise.race([scope.navigator.serviceWorker.ready, timeout]);
        return registration.pushManager;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function decodeServerKey(key: string): Uint8Array<ArrayBuffer> {
  const padded = key
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(key.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function drop(subscription: PushSubscriptionLike): Promise<void> {
  try {
    await subscription.unsubscribe();
  } catch (cause) {
    const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : '';
    throw new PushSetupError(
      `The browser could not drop its push subscription${detail}. Reload the page and try again.`,
    );
  }
}

async function discard(subscription: PushSubscriptionLike): Promise<void> {
  await subscription.unsubscribe().catch((cause: unknown) => {
    console.error('Could not drop an unused push subscription', cause);
  });
}

const lostResponse = (cause: unknown): boolean =>
  cause instanceof ApiRequestError && cause.status === 0;

function sameKey(subscription: PushSubscriptionLike, key: Uint8Array): boolean {
  const current = subscription.options?.applicationServerKey;
  if (!current) return true;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((value, index) => value === key[index]);
}

export async function currentEndpoint(host: PushHost): Promise<string | null> {
  const subscription = await (await host.pushManager()).getSubscription();
  return subscription?.endpoint ?? null;
}

function toRequest(subscription: PushSubscriptionLike): PushSubscriptionRequest {
  const { endpoint, keys } = subscription.toJSON();
  const p256dh = keys?.['p256dh'];
  const auth = keys?.['auth'];
  if (!endpoint || !p256dh || !auth) {
    throw new PushSetupError(
      'This browser returned an incomplete push subscription. Try again, or use mail reminders.',
    );
  }
  return { endpoint, keys: { p256dh, auth } };
}

export const isOwnedByAnotherAccount = (cause: unknown): boolean =>
  cause instanceof ApiRequestError && cause.code === 'push_device_owned';

/** Must run inside a click handler: the permission prompt needs a user gesture. */
export async function subscribeThisDevice(
  host: PushHost,
  api: PushApi,
  vapidPublicKey: string,
): Promise<string> {
  let permission = host.permission();
  if (permission === 'default') permission = await host.requestPermission();
  if (permission === 'denied') {
    throw new PushSetupError(
      'Notifications are blocked for this site. Allow them in your browser settings, then try again.',
    );
  }
  if (permission !== 'granted') {
    throw new PushSetupError('Notification permission was not granted, so push stays off.');
  }

  const manager = await host.pushManager();
  const key = decodeServerKey(vapidPublicKey);
  const subscribe = () => manager.subscribe({ userVisibleOnly: true, applicationServerKey: key });

  let subscription = await manager.getSubscription();
  let created = false;
  if (subscription && !sameKey(subscription, key)) {
    // The old endpoint is useless for the new key but still counts toward the device limit.
    await api.removePushSubscription(subscription.endpoint).catch((cause: unknown) => {
      console.error('Could not delete the outdated push subscription on the server', cause);
    });
    await drop(subscription);
    subscription = null;
  }
  if (!subscription) {
    try {
      subscription = await subscribe();
    } catch (cause) {
      const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : '';
      throw new PushSetupError(
        `The browser could not subscribe to push${detail}. Use mail reminders instead.`,
      );
    }
    created = true;
  }

  try {
    await api.addPushSubscription(toRequest(subscription));
    return subscription.endpoint;
  } catch (cause) {
    if (!isOwnedByAnotherAccount(cause)) {
      // After a lost response the server may have stored the row; keeping the subscription lets a retry match it.
      if (created && !lostResponse(cause)) await discard(subscription);
      throw cause;
    }
  }

  // The server refuses an endpoint whose keys differ from the registered ones, so take a fresh one.
  await drop(subscription);
  let fresh: PushSubscriptionLike;
  try {
    fresh = await subscribe();
  } catch {
    throw new PushSetupError(
      'This browser is registered to another account. Remove the site from your browser notification settings, then try again.',
    );
  }
  try {
    await api.addPushSubscription(toRequest(fresh));
  } catch (cause) {
    if (!lostResponse(cause)) await discard(fresh);
    if (isOwnedByAnotherAccount(cause)) {
      throw new PushSetupError(
        'This browser is still registered to another account. Remove the site from your browser notification settings, then try again.',
      );
    }
    throw cause;
  }
  return fresh.endpoint;
}

export type RemoveResult = 'none' | 'removed' | 'not-registered';

/** The browser subscription is dropped only when the server deleted this account's row, so another account's endpoint on a shared browser survives. */
export async function removeThisDevice(host: PushHost, api: PushApi): Promise<RemoveResult> {
  const subscription = await (await host.pushManager()).getSubscription();
  if (!subscription) return 'none';
  const { removed } = await api.removePushSubscription(subscription.endpoint);
  if (!removed) return 'not-registered';
  await drop(subscription);
  return 'removed';
}
