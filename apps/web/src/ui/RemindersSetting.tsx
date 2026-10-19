import type { PushDevice, ReminderSettings } from '@aquarium/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  browserPushHost,
  currentEndpoint,
  PushSetupError,
  removeThisDevice,
  subscribeThisDevice,
  type PushHost,
} from '../pwa/push';
import { ApiRequestError } from './api';
import { useApi } from './context';
import { FormError, useSubmission } from './screens';

export type PushSupport =
  | { kind: 'server-off' }
  | { kind: 'browser-unsupported' }
  | { kind: 'blocked' }
  | { kind: 'ready' };

export function pushSupport(settings: ReminderSettings, host: PushHost | null): PushSupport {
  if (!settings.pushAvailable || settings.vapidPublicKey === null) return { kind: 'server-off' };
  if (!host) return { kind: 'browser-unsupported' };
  if (host.permission() === 'denied') return { kind: 'blocked' };
  return { kind: 'ready' };
}

export function reminderErrorMessage(cause: ApiRequestError): string {
  if (cause.code === 'rate_limited') {
    const wait = cause.retryAfterSeconds;
    return wait
      ? `Too many changes. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.`
      : 'Too many changes. Try again later.';
  }
  if (cause.code === 'push_device_limit') {
    return 'You already have the maximum number of push devices. Remove one from the list, then try again.';
  }
  if (cause.code === 'push_device_owned') {
    return 'This browser is registered to another account. Remove the site from your browser notification settings, then try again.';
  }
  if (cause.code === 'email_not_verified') {
    return 'Verify your email address before turning on mail reminders. Check your inbox for the link.';
  }
  return cause.message;
}

export interface RemindersViewProps {
  settings: ReminderSettings;
  support: PushSupport;
  devices: readonly PushDevice[];
  busy: boolean;
  error: string | null;
  status: string;
  onMail(on: boolean): void;
  onPush(on: boolean): void;
  onAddDevice(): void;
  onRemoveDevice(device: PushDevice): void;
}

const PUSH_NOTES: Record<Exclude<PushSupport['kind'], 'ready'>, string> = {
  'server-off': 'Push reminders are not available on this server yet. Mail reminders still work.',
  'browser-unsupported':
    'This browser cannot receive push notifications here. On iPhone or iPad, add the app to your home screen first.',
  blocked:
    'Notifications are blocked for this site. Allow them in your browser settings to use push.',
};

export function RemindersView({
  settings,
  support,
  devices,
  busy,
  error,
  status,
  onMail,
  onPush,
  onAddDevice,
  onRemoveDevice,
}: RemindersViewProps) {
  const pushReady = support.kind === 'ready';
  const thisBrowser = devices.find((device) => device.current);
  return (
    <section aria-labelledby="reminders-title">
      <h2 id="reminders-title">Care reminders</h2>
      <p>
        A nudge at most once a day when you have fish and have not fed them for a while. Both are
        off until you turn them on.
      </p>
      <label>
        <input
          type="checkbox"
          checked={settings.mail}
          disabled={busy}
          aria-describedby="reminders-mail-note"
          onChange={(e) => onMail(e.target.checked)}
        />{' '}
        Reminder emails
      </label>
      <p id="reminders-mail-note" className="hint">
        Every email has a one-click unsubscribe link.
      </p>
      <label>
        <input
          type="checkbox"
          checked={settings.push}
          disabled={busy || (!pushReady && !settings.push)}
          aria-describedby="reminders-push-note"
          onChange={(e) => onPush(e.target.checked)}
        />{' '}
        Push notifications
      </label>
      <p id="reminders-push-note" className="hint">
        {support.kind === 'ready'
          ? 'Your browser asks for permission when you turn this on.'
          : PUSH_NOTES[support.kind]}
      </p>
      {pushReady && (
        <>
          <h3 id="reminders-devices-title">Push devices</h3>
          <ul aria-labelledby="reminders-devices-title" className="devices">
            {devices.map((device) => (
              <li key={device.id}>
                {device.label}
                {device.current ? ' (this browser)' : ''}, added{' '}
                {new Date(device.createdAt).toLocaleDateString()}{' '}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  aria-label={`Remove ${device.label}${device.current ? ' (this browser)' : ''}, added ${new Date(device.createdAt).toLocaleDateString()}`}
                  onClick={() => onRemoveDevice(device)}
                >
                  Remove
                </button>
              </li>
            ))}
            {devices.length === 0 && <li>No devices are registered on your account.</li>}
            {!thisBrowser && (
              <li>
                This browser is not registered on your account.{' '}
                <button type="button" className="secondary" disabled={busy} onClick={onAddDevice}>
                  Set up this browser
                </button>
              </li>
            )}
          </ul>
        </>
      )}
      <p role="status" className="hint">
        {busy ? 'Saving…' : status}
      </p>
      <FormError message={error} />
    </section>
  );
}

interface Loaded {
  settings: ReminderSettings;
  devices: PushDevice[];
}

export function RemindersSetting() {
  const api = useApi();
  const host = useMemo(() => browserPushHost(), []);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const change = useSubmission();

  const load = useCallback(async (): Promise<Loaded> => {
    const settings = await api.reminders();
    if (!settings.pushAvailable) return { settings, devices: [] };
    const endpoint = host ? await currentEndpoint(host).catch(() => null) : null;
    return { settings, devices: await api.pushDevices(endpoint) };
  }, [api, host]);

  const refresh = useCallback(async () => {
    try {
      setLoaded(await load());
      setLoadError(null);
    } catch (cause) {
      console.error(cause);
      setLoadError(
        cause instanceof ApiRequestError
          ? reminderErrorMessage(cause)
          : 'Could not load your reminder settings.',
      );
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!loaded) {
    return (
      <section aria-labelledby="reminders-title">
        <h2 id="reminders-title">Care reminders</h2>
        {loadError ? (
          <>
            <FormError message={loadError} />
            <button type="button" onClick={() => void refresh()}>
              Try again
            </button>
          </>
        ) : (
          <p role="status">Loading…</p>
        )}
      </section>
    );
  }
  const { settings, devices } = loaded;

  const update = (label: string, action: () => Promise<unknown>, message: string) => {
    setStatus('');
    void change
      .run(async () => {
        try {
          await action();
        } catch (cause) {
          if (cause instanceof ApiRequestError) {
            throw new ApiRequestError(
              cause.status,
              cause.code,
              `${label}: ${reminderErrorMessage(cause)}`,
              cause.fields,
              cause.retryAfterSeconds,
            );
          }
          throw cause;
        } finally {
          // A step may have succeeded before a later one failed, so the shown state could be stale.
          await refresh();
        }
      })
      .then((ok) => setStatus(ok ? message : ''));
  };

  const enableDevice = async () => {
    if (host && settings.vapidPublicKey !== null) {
      await subscribeThisDevice(host, api, settings.vapidPublicKey);
    }
  };

  const removeDevice = async (device: PushDevice) => {
    if (!device.current) {
      await api.removePushDevice(device.id);
      return;
    }
    if (!host) return;
    if ((await removeThisDevice(host, api)) === 'not-registered') {
      throw new PushSetupError(
        'This browser’s push subscription is not registered to your account, so nothing was removed and the subscription is unchanged.',
      );
    }
  };

  return (
    <RemindersView
      settings={settings}
      support={pushSupport(settings, host)}
      devices={devices}
      busy={change.busy}
      error={change.error ?? loadError}
      status={status}
      onMail={(on) =>
        update(
          'Could not change mail reminders',
          () => api.updateReminders({ mail: on }),
          on ? 'Reminder emails are on.' : 'Reminder emails are off.',
        )
      }
      onPush={(on) =>
        update(
          'Could not change push reminders',
          async () => {
            if (on) await enableDevice();
            return api.updateReminders({ push: on });
          },
          on ? 'Push notifications are on.' : 'Push notifications are off.',
        )
      }
      onAddDevice={() =>
        update('Could not set up this browser', enableDevice, 'Push is set up in this browser.')
      }
      onRemoveDevice={(device) =>
        update('Could not remove the device', () => removeDevice(device), 'Device removed.')
      }
    />
  );
}
