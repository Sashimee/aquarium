import { devices, expect, test, type Page } from '@playwright/test';
import { registerVerifiedUser } from './support/app.ts';

const START = '/?backend=webgl&tier=low';
const CACHE_NAME = /^aquarium-(shell|assets)-[0-9a-f]{12}$/;

test.use({ serviceWorkers: 'allow' });

async function workerControlsPage(page: Page): Promise<void> {
  await page.goto(START, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}

async function openSettings(page: Page, identity: string): Promise<void> {
  await registerVerifiedUser(page, identity);
  await page.goto('/settings?backend=webgl&tier=low', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
}

async function cachedPaths(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(async () => {
    const out: Record<string, string[]> = {};
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      out[name] = (await cache.keys()).map((request) => new URL(request.url).pathname);
    }
    return out;
  });
}

const allPaths = (cached: Record<string, string[]>) => Object.values(cached).flat();

test.describe('PWA', () => {
  test('passes Chromium installability checks', async ({ page, context }) => {
    await page.goto(START, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => navigator.serviceWorker.ready);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.enable');
    await expect
      .poll(
        async () => {
          const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as {
            installabilityErrors: { errorId: string }[];
          };
          return installabilityErrors.map((e) => e.errorId);
        },
        { message: 'installability errors reported by Chromium' },
      )
      .toEqual([]);

    const { url, errors } = (await cdp.send('Page.getAppManifest')) as {
      url: string;
      errors: { message: string }[];
    };
    expect(url).toMatch(/\/manifest\.webmanifest$/);
    expect(errors).toEqual([]);
  });

  test('serves the worker and manifest so browsers revalidate them', async ({ request }) => {
    const sw = await request.get('/sw.js');
    expect(sw.status()).toBe(200);
    expect(sw.headers()['cache-control']).toBe('no-cache');
    expect(sw.headers()['content-type']).toContain('javascript');
    const manifest = await request.get('/manifest.webmanifest');
    expect(manifest.headers()['content-type']).toContain('manifest');
  });

  test('caches hashed bundles and the shell but never /api', async ({ page }) => {
    await workerControlsPage(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect
      .poll(async () =>
        allPaths(await cachedPaths(page)).some((path) => /^\/assets\/.+\.js$/.test(path)),
      )
      .toBe(true);

    await page.evaluate(async () => {
      await fetch('/api/health');
      await fetch('/api/auth/get-session');
    });
    const cached = await cachedPaths(page);
    expect(Object.keys(cached).length).toBeGreaterThan(0);
    for (const name of Object.keys(cached)) expect(name).toMatch(CACHE_NAME);
    expect(allPaths(cached)).toContain('/offline.html');
    expect(allPaths(cached).filter((path) => path.startsWith('/api'))).toEqual([]);
  });

  test('shows the tank-is-asleep page when offline and does not serve the API from cache', async ({
    page,
    context,
  }) => {
    await workerControlsPage(page);
    const fetchHealth = () =>
      page.evaluate(() =>
        fetch('/api/health').then(
          (res) => res.status,
          () => 'failed' as const,
        ),
      );
    expect(await fetchHealth()).toBe(200);

    await context.setOffline(true);
    await page.goto('/tank/1', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'The tank is asleep' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try again' })).toBeVisible();
    expect(await fetchHealth()).toBe('failed');
  });

  test('offers the browser install prompt in Settings', async ({ page }) => {
    await openSettings(page, 'pwa-install');
    await page.evaluate(() => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      Object.assign(event, {
        prompt: async () => undefined,
        userChoice: Promise.resolve({ outcome: 'dismissed' }),
      });
      window.dispatchEvent(event);
    });
    const install = page.getByRole('button', { name: 'Install Aquarium' });
    await expect(install).toBeVisible();
    await install.click();
    await expect(page.getByText('Installation was cancelled')).toBeVisible();
  });
});

test.describe('PWA on iOS Safari', () => {
  test.use({ userAgent: devices['iPhone 15 Pro'].userAgent });

  test('shows the Add to Home Screen hint', async ({ page }) => {
    await openSettings(page, 'pwa-ios');
    await expect(page.getByText('Add to Home Screen')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Install Aquarium' })).toHaveCount(0);
  });
});
