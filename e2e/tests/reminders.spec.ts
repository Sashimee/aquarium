import { expect, test, type Page } from '@playwright/test';
import { registerVerifiedUser } from '../support/app.ts';

test.use({ serviceWorkers: 'allow' });

const SHOTS = process.env['E2E_SHOTS'];

// Settings never looks at the tank, so skip rendering its models and textures in software.
async function skipSceneAssets(page: Page): Promise<void> {
  await page.route('**/assets/**', (route) => {
    const { pathname } = new URL(route.request().url());
    return /\.(js|css)$/.test(pathname) ? route.continue() : route.abort();
  });
}

// Headless Chromium has no push service to subscribe to, so the browser side is replaced by an
// in-memory one that survives reloads. The server, its endpoint allow-list and the UI are real.
async function fakePushManager(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const KEY = 'e2e-fake-push';
    const read = (): { endpoint: string } | null => JSON.parse(localStorage.getItem(KEY) ?? 'null');
    const wrap = (stored: { endpoint: string }) => ({
      endpoint: stored.endpoint,
      options: { applicationServerKey: null },
      toJSON: () => ({
        endpoint: stored.endpoint,
        keys: { p256dh: 'B'.padEnd(87, 'x'), auth: 'a'.repeat(22) },
      }),
      unsubscribe: async () => {
        localStorage.removeItem(KEY);
        return true;
      },
    });
    Object.defineProperty(Notification, 'permission', {
      get: () => localStorage.getItem('e2e-fake-permission') ?? 'default',
    });
    Notification.requestPermission = async () => {
      localStorage.setItem('e2e-fake-permission', 'granted');
      localStorage.setItem('e2e-fake-prompted', 'yes');
      return 'granted';
    };
    PushManager.prototype.getSubscription = async () => {
      const stored = read();
      return stored ? (wrap(stored) as unknown as PushSubscription) : null;
    };
    PushManager.prototype.subscribe = async () => {
      const stored = { endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}` };
      localStorage.setItem(KEY, JSON.stringify(stored));
      return wrap(stored) as unknown as PushSubscription;
    };
  });
}

async function openSettings(page: Page): Promise<void> {
  await page.goto('/settings?backend=webgl&tier=low');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Care reminders' })).toBeVisible();
}

const mail = (page: Page) => page.getByRole('checkbox', { name: 'Reminder emails' });
const push = (page: Page) => page.getByRole('checkbox', { name: 'Push notifications' });

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  const original = page.viewportSize();
  for (const [label, width, height] of [
    ['phone', 390, 844],
    ['desktop', 1280, 800],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.locator('section[aria-labelledby="reminders-title"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/${name}-${label}.png` });
  }
  if (original) await page.setViewportSize(original);
}

test('mail reminders start off, opt in, persist across reload, then opt out', async ({ page }) => {
  await skipSceneAssets(page);
  await registerVerifiedUser(page, 'remindmail');
  await openSettings(page);

  await expect(mail(page)).not.toBeChecked();
  await expect(push(page)).not.toBeChecked();

  await mail(page).click();
  await expect(page.getByText('Reminder emails are on.')).toBeVisible();
  await expect(mail(page)).toBeChecked();
  await shot(page, 'mail-on');

  await page.reload();
  await expect(mail(page)).toBeChecked();

  await mail(page).click();
  await expect(page.getByText('Reminder emails are off.')).toBeVisible();
  await page.reload();
  await expect(mail(page)).not.toBeChecked();
});

test('push: permission on click, device list, remove, and a shared browser takes a fresh endpoint', async ({
  page,
}) => {
  await skipSceneAssets(page);
  await fakePushManager(page);
  await registerVerifiedUser(page, 'remindpush');
  await page.goto('/?backend=webgl&tier=low');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await openSettings(page);

  await expect(push(page)).toBeEnabled();
  await expect(page.getByText('This device: not set up')).toBeVisible();
  await expect(page.evaluate(() => localStorage.getItem('e2e-fake-push'))).resolves.toBeNull();

  await expect(page.evaluate(() => localStorage.getItem('e2e-fake-prompted'))).resolves.toBeNull();
  await push(page).click();
  await expect(page.getByText('Push notifications are on.')).toBeVisible();
  await expect(page.evaluate(() => localStorage.getItem('e2e-fake-prompted'))).resolves.toBe('yes');
  await expect(page.getByText('This device: receiving push')).toBeVisible();
  await shot(page, 'push-on');

  await page.reload();
  await expect(push(page)).toBeChecked();
  await expect(page.getByText('This device: receiving push')).toBeVisible();

  await push(page).click();
  await expect(page.getByText('Push notifications are off.')).toBeVisible();
  await expect(page.getByText('This device: receiving push')).toBeVisible();

  await page.getByRole('button', { name: 'Remove this device' }).click();
  await expect(page.getByText('This device was removed.')).toBeVisible();
  await expect(page.getByText('This device: not set up')).toBeVisible();
  await expect(page.evaluate(() => localStorage.getItem('e2e-fake-push'))).resolves.toBeNull();
  const afterRemove = await page.request.get('/api/me/reminders');
  expect(((await afterRemove.json()) as { subscriptions: number }).subscriptions).toBe(0);

  await page.getByRole('button', { name: 'Add this device' }).click();
  await expect(page.getByText('This device: receiving push')).toBeVisible();
  const first = await page.evaluate(() => localStorage.getItem('e2e-fake-push'));

  await registerVerifiedUser(page, 'remindpush2');
  await openSettings(page);
  await expect(page.getByText('This device: receiving push')).toBeVisible();
  await expect(push(page)).not.toBeChecked();
  await push(page).click();
  await expect(page.getByText('Push notifications are on.')).toBeVisible();
  const second = await page.evaluate(() => localStorage.getItem('e2e-fake-push'));
  expect(second, 'the shared browser got a fresh endpoint').not.toBe(first);
  const settings = await page.request.get('/api/me/reminders');
  expect(await settings.json()).toMatchObject({ push: true, subscriptions: 1 });
});

test('notifications blocked in the browser are explained, not attempted', async ({ page }) => {
  await skipSceneAssets(page);
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'denied' });
  });
  await registerVerifiedUser(page, 'remindblocked');
  await page.goto('/?backend=webgl&tier=low');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await openSettings(page);
  await expect(push(page)).toBeDisabled();
  await expect(page.getByText('Notifications are blocked for this site.')).toBeVisible();
});
