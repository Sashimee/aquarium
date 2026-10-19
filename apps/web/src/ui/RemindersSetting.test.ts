import type { PushDevice, ReminderSettings } from '@aquarium/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PushHost } from '../pwa/push';
import { ApiRequestError, createApiClient } from './api';
import {
  pushSupport,
  reminderErrorMessage,
  RemindersView,
  type PushSupport,
  type RemindersViewProps,
} from './RemindersSetting';

const settings = (over: Partial<ReminderSettings> = {}): ReminderSettings => ({
  mail: false,
  push: false,
  pushAvailable: true,
  vapidPublicKey: 'BKey',
  subscriptions: 0,
  ...over,
});

const host = (permission: NotificationPermission): PushHost => ({
  permission: () => permission,
  requestPermission: async () => permission,
  pushManager: async () => {
    throw new Error('unused');
  },
});

function render(support: PushSupport, s: ReminderSettings, over: Partial<RemindersViewProps> = {}) {
  return renderToStaticMarkup(
    createElement(RemindersView, {
      settings: s,
      support,
      devices: [],
      busy: false,
      error: null,
      status: '',
      onMail: () => undefined,
      onPush: () => undefined,
      onAddDevice: () => undefined,
      onRemoveDevice: () => undefined,
      ...over,
    }),
  );
}

describe('pushSupport', () => {
  it('is off when the server has no VAPID keys', () => {
    expect(
      pushSupport(settings({ pushAvailable: false, vapidPublicKey: null }), host('default')),
    ).toEqual({ kind: 'server-off' });
  });
  it('is unsupported without a browser host', () => {
    expect(pushSupport(settings(), null)).toEqual({ kind: 'browser-unsupported' });
  });
  it('is blocked once the user denied notifications', () => {
    expect(pushSupport(settings(), host('denied'))).toEqual({ kind: 'blocked' });
  });
  it('is ready otherwise', () => {
    expect(pushSupport(settings(), host('default'))).toEqual({ kind: 'ready' });
  });
});

describe('reminderErrorMessage', () => {
  it('turns the unverified-email error into guidance', () => {
    const msg = reminderErrorMessage(new ApiRequestError(403, 'email_not_verified', 'x'));
    expect(msg).toMatch(/Verify your email/);
  });
  it('tells how long to wait when rate limited', () => {
    expect(reminderErrorMessage(new ApiRequestError(429, 'rate_limited', 'x', {}, 300))).toContain(
      '5 minutes',
    );
    expect(reminderErrorMessage(new ApiRequestError(429, 'rate_limited', 'x'))).toMatch(/later/);
  });
  it('gives the device limit and shared-browser errors their own guidance', () => {
    expect(reminderErrorMessage(new ApiRequestError(409, 'push_device_limit', 'x'))).toMatch(
      /Remove one/,
    );
    expect(reminderErrorMessage(new ApiRequestError(409, 'push_device_owned', 'x'))).toMatch(
      /another account/,
    );
  });
  it('passes other server messages through', () => {
    expect(reminderErrorMessage(new ApiRequestError(409, 'conflict', 'Nope.'))).toBe('Nope.');
  });
});

describe('RemindersView', () => {
  it('shows both off by default and hides the device list when push is off', () => {
    const html = render(
      { kind: 'server-off' },
      settings({ pushAvailable: false, vapidPublicKey: null }),
    );
    expect(html).not.toMatch(/<input[^>]*checked/);
    expect(html).toContain('not available on this server yet');
    expect(html).not.toContain('Push devices');
    const push = /<input[^>]*aria-describedby="reminders-push-note"[^>]*>/.exec(html)?.[0] ?? '';
    expect(push).toContain('disabled');
  });

  it('reflects the server state for mail', () => {
    const html = render({ kind: 'server-off' }, settings({ mail: true }));
    expect(html).toMatch(/<input[^>]*aria-describedby="reminders-mail-note"[^>]*checked/);
  });

  it('lists devices, marks this browser and offers removal for each', () => {
    const devices: PushDevice[] = [
      {
        id: 'a',
        label: 'fcm.googleapis.com',
        createdAt: '2026-10-01T00:00:00.000Z',
        lastUsedAt: null,
        current: true,
      },
      {
        id: 'b',
        label: 'push.apple.com',
        createdAt: '2026-10-02T00:00:00.000Z',
        lastUsedAt: null,
        current: false,
      },
    ];
    const html = render({ kind: 'ready' }, settings({ push: true, subscriptions: 2 }), { devices });
    expect(html).toContain('fcm.googleapis.com (this browser)');
    expect(html).toContain('push.apple.com');
    expect(html.match(/>Remove</g)).toHaveLength(2);
    expect(html).not.toContain('Set up this browser');
  });

  it('offers setup when this browser is not on the account', () => {
    const html = render({ kind: 'ready' }, settings({ push: true }), {
      devices: [
        {
          id: 'b',
          label: 'push.apple.com',
          createdAt: '2026-10-02T00:00:00.000Z',
          lastUsedAt: null,
          current: false,
        },
      ],
    });
    expect(html).toContain('This browser is not registered on your account.');
    expect(html).toContain('Set up this browser');
  });

  it('disables the controls while a change is in flight and shows errors', () => {
    const html = render({ kind: 'ready' }, settings(), {
      busy: true,
      error: 'Could not change mail reminders: boom',
    });
    expect(html).toContain('Could not change mail reminders: boom');
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['blocked', { kind: 'blocked' }],
    ['browser-unsupported', { kind: 'browser-unsupported' }],
    ['server-off', { kind: 'server-off' }],
  ] as const)(
    'keeps push checked and switchable off when it is on and support is %s',
    (_name, support) => {
      const html = render(support, settings({ push: true }));
      const input = /<input[^>]*aria-describedby="reminders-push-note"[^>]*>/.exec(html)?.[0] ?? '';
      expect(input).toContain('checked');
      expect(input).not.toContain('disabled');
    },
  );

  it('does not let push be turned on without support', () => {
    const html = render({ kind: 'blocked' }, settings({ push: false }));
    const input = /<input[^>]*aria-describedby="reminders-push-note"[^>]*>/.exec(html)?.[0] ?? '';
    expect(input).toContain('disabled');
  });

  it('explains a blocked or unsupported browser', () => {
    expect(render({ kind: 'blocked' }, settings())).toContain('blocked for this site');
    expect(render({ kind: 'browser-unsupported' }, settings())).toContain('home screen');
  });
});

describe('reminder api client', () => {
  const settingsBody = JSON.stringify(settings({ mail: true }));
  const ok = (body: string) => async () => new Response(body, { status: 200 });

  it('reads settings and rejects an unreadable response', async () => {
    await expect(createApiClient(ok(settingsBody)).reminders()).resolves.toMatchObject({
      mail: true,
    });
    await expect(createApiClient(ok('{"mail":1}')).reminders()).rejects.toMatchObject({
      code: 'unexpected_response',
    });
  });

  it('sends only the changed field with PUT', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const api = createApiClient(async (url, init) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return new Response(settingsBody, { status: 200 });
    });
    await api.updateReminders({ mail: true });
    expect(calls[0]?.url).toBe('/api/me/reminders');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(calls[0]?.init?.body).toBe('{"mail":true}');
  });

  it('refuses an empty change before calling the server', async () => {
    const api = createApiClient(async () => {
      throw new Error('must not be called');
    });
    await expect(api.updateReminders({})).rejects.toThrow('Please fix');
  });

  it('surfaces the server error envelope on a failed update', async () => {
    const body = JSON.stringify({
      error: { code: 'email_not_verified', message: 'Verify first.' },
    });
    const api = createApiClient(async () => new Response(body, { status: 403 }));
    await expect(api.updateReminders({ mail: true })).rejects.toMatchObject({
      status: 403,
      code: 'email_not_verified',
    });
  });
});

describe('push device api client', () => {
  it('asks for the list with the current endpoint and returns the devices', async () => {
    const urls: string[] = [];
    const body = JSON.stringify({
      devices: [
        {
          id: '0b8f2f58-6f65-4d3c-9d3e-3f1f7f0f8a11',
          label: 'fcm.googleapis.com',
          createdAt: '2026-10-01T00:00:00.000Z',
          lastUsedAt: null,
          current: true,
        },
      ],
    });
    const api = createApiClient(async (url) => {
      urls.push(url);
      return new Response(body, { status: 200 });
    });
    const devices = await api.pushDevices('https://fcm.googleapis.com/fcm/send/x');
    expect(urls[0]).toBe(
      '/api/me/push-subscriptions?endpoint=https%3A%2F%2Ffcm.googleapis.com%2Ffcm%2Fsend%2Fx',
    );
    expect(devices[0]?.current).toBe(true);
  });

  it('removes by id with DELETE and parses the result', async () => {
    const calls: { url: string; method?: string | undefined }[] = [];
    const api = createApiClient(async (url, init) => {
      calls.push({ url, method: init?.method });
      return new Response('{"removed":true}', { status: 200 });
    });
    expect(await api.removePushDevice('a b')).toEqual({ removed: true });
    expect(calls[0]).toEqual({ url: '/api/me/push-subscriptions/a%20b', method: 'DELETE' });
  });

  it('parses the remove-by-endpoint result and rejects a malformed one', async () => {
    const ok = createApiClient(async () => new Response('{"removed":false}', { status: 200 }));
    expect(await ok.removePushSubscription('https://fcm.googleapis.com/x')).toEqual({
      removed: false,
    });
    const bad = createApiClient(async () => new Response('{}', { status: 200 }));
    await expect(bad.removePushSubscription('https://fcm.googleapis.com/x')).rejects.toMatchObject({
      code: 'unexpected_response',
    });
  });
});
