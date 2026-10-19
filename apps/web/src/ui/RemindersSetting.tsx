import type { ReminderSettings } from '@aquarium/shared';
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
  | { kind: 'ready'; endpoint: string | null };

export function pushSupport(
  settings: ReminderSettings,
  host: PushHost | null,
  endpoint: string | null,
): PushSupport {
  if (!settings.pushAvailable || settings.vapidPublicKey === null) return { kind: 'server-off' };
  if (!host) return { kind: 'browser-unsupported' };
  if (host.permission() === 'denied') return { kind: 'blocked' };
  return { kind: 'ready', endpoint };
}

export function reminderErrorMessage(cause: ApiRequestError): string {
  if (cause.code === 'rate_limited') {
    const wait = cause.retryAfterSeconds;
    return wait
      ? `Too many changes. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.`
      : 'Too many changes. Try again later.';
  }
  if (cause.code === 'email_not_verified') {
    return 'Verify your email address before turning on mail reminders. Check your inbox for the link.';
  }
  return cause.message;
}

export interface RemindersViewProps {
  settings: ReminderSettings;
  support: PushSupport;
  busy: boolean;
  error: string | null;
  status: string;
  onMail(on: boolean): void;
  onPush(on: boolean): void;
  onAddDevice(): void;
  onRemoveDevice(): void;
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
  busy,
  error,
  status,
  onMail,
  onPush,
  onAddDevice,
  onRemoveDevice,
}: RemindersViewProps) {
  const pushReady = support.kind === 'ready';
  const thisDevice = support.kind === 'ready' ? support.endpoint : null;
  const others = Math.max(0, settings.subscriptions - (thisDevice ? 1 : 0));
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
          checked={settings.push && pushReady}
          disabled={busy || !pushReady}
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
            <li>
              This device: {thisDevice ? 'receiving push' : 'not set up'}{' '}
              {thisDevice ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={onRemoveDevice}
                >
                  Remove this device
                </button>
              ) : (
                <button type="button" className="secondary" disabled={busy} onClick={onAddDevice}>
                  Add this device
                </button>
              )}
            </li>
            {others > 0 && (
              <li>
                {others} other {others === 1 ? 'device' : 'devices'}. Remove one by opening this
                page on it.
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

export function RemindersSetting() {
  const api = useApi();
  const host = useMemo(() => browserPushHost(), []);
  const [settings, setSettings] = useState<ReminderSettings | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const change = useSubmission();

  const refresh = useCallback(async () => {
    try {
      setSettings(await api.reminders());
      setLoadError(null);
    } catch (cause) {
      console.error(cause);
      setLoadError(
        cause instanceof ApiRequestError
          ? reminderErrorMessage(cause)
          : 'Could not load your reminder settings.',
      );
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const available = settings?.pushAvailable === true;
  useEffect(() => {
    if (!host || !available) return;
    let live = true;
    currentEndpoint(host).then(
      (value) => live && setEndpoint(value),
      (cause: unknown) => console.error(cause),
    );
    return () => {
      live = false;
    };
  }, [host, available]);

  if (!settings) {
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

  const update = (label: string, action: () => Promise<ReminderSettings>, message: string) => {
    setStatus('');
    void change
      .run(async () => {
        try {
          setSettings(await action());
        } catch (cause) {
          if (cause instanceof PushSetupError) {
            throw new ApiRequestError(0, 'validation_failed', cause.message);
          }
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
        }
      })
      .then((ok) => setStatus(ok ? message : ''));
  };

  const enableDevice = async () => {
    if (!host || settings.vapidPublicKey === null) return api.reminders();
    setEndpoint(await subscribeThisDevice(host, api, settings.vapidPublicKey));
    return api.reminders();
  };

  return (
    <RemindersView
      settings={settings}
      support={pushSupport(settings, host, endpoint)}
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
            if (on && host && settings.vapidPublicKey !== null) {
              setEndpoint(await subscribeThisDevice(host, api, settings.vapidPublicKey));
            }
            return api.updateReminders({ push: on });
          },
          on ? 'Push notifications are on.' : 'Push notifications are off.',
        )
      }
      onAddDevice={() =>
        update(
          'Could not add this device',
          enableDevice,
          'This device will get push notifications.',
        )
      }
      onRemoveDevice={() =>
        update(
          'Could not remove this device',
          async () => {
            if (host) await removeThisDevice(host, api);
            setEndpoint(null);
            return api.reminders();
          },
          'This device was removed.',
        )
      }
    />
  );
}
