import { expect, test, type Page } from '@playwright/test';

const START = '/?backend=webgl&tier=low';

async function workerControlsPage(page: Page): Promise<void> {
  await page.goto(START, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}

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

  test('keeps /api out of the caches', async ({ page }) => {
    await workerControlsPage(page);
    await page.evaluate(() => fetch('/api/health'));
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) urls.push(new URL(request.url).pathname);
      }
      return urls;
    });
    expect(cached).toContain('/offline.html');
    expect(cached.filter((path) => path.startsWith('/api'))).toEqual([]);
  });

  test('shows the tank-is-asleep page when offline', async ({ page, context }) => {
    await workerControlsPage(page);
    await context.setOffline(true);
    await page.goto('/tank/1', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'The tank is asleep' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try again' })).toBeVisible();
    const api = await page.evaluate(() =>
      fetch('/api/health').then(
        () => 'served',
        () => 'failed',
      ),
    );
    expect(api).toBe('failed');
    await context.setOffline(false);
  });
});
