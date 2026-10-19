import type { ReminderSettings } from '@aquarium/shared';
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
      pushSupport(settings({ pushAvailable: false, vapidPublicKey: null }), host('default'), null),
    ).toEqual({ kind: 'server-off' });
  });
  it('is unsupported without a browser host', () => {
    expect(pushSupport(settings(), null, null)).toEqual({ kind: 'browser-unsupported' });
  });
  it('is blocked once the user denied notifications', () => {
    expect(pushSupport(settings(), host('denied'), null)).toEqual({ kind: 'blocked' });
  });
  it('is ready otherwise and carries this device endpoint', () => {
    expect(pushSupport(settings(), host('default'), 'https://fcm.googleapis.com/x')).toEqual({
      kind: 'ready',
      endpoint: 'https://fcm.googleapis.com/x',
    });
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

  it('offers to add this device and counts other devices', () => {
    const html = render(
      { kind: 'ready', endpoint: null },
      settings({ push: true, subscriptions: 2 }),
    );
    expect(html).toContain('Set up this browser');
    expect(html).toContain('2 devices');
  });

  it('offers removal when this device is subscribed', () => {
    const html = render(
      { kind: 'ready', endpoint: 'https://fcm.googleapis.com/x' },
      settings({ push: true, subscriptions: 1 }),
    );
    expect(html).toContain('Remove this browser');
    expect(html).toContain('1 device');
  });

  it('disables the controls while a change is in flight and shows errors', () => {
    const html = render({ kind: 'ready', endpoint: null }, settings(), {
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
