import { expect, test, type Page, type Route } from '@playwright/test';
import { awaitLoaded } from './support/app.ts';

declare global {
  interface Window {
    __loadValues: number[];
  }
}

const LOAD_MS = 150_000;

const bar = (page: Page) => page.getByRole('progressbar');

async function recordProgress(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__loadValues = [];
    const read = (): void => {
      const node = document.querySelector('[role="progressbar"]');
      const value = Number(node?.getAttribute('aria-valuenow'));
      if (node && Number.isFinite(value)) window.__loadValues.push(value);
    };
    new MutationObserver(read).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-valuenow'],
    });
  });
}

const recorded = (page: Page) => page.evaluate(() => window.__loadValues.slice());

function expectRising(values: readonly number[]): void {
  expect(values.length, 'the progressbar reported values').toBeGreaterThan(0);
  expect(
    values.every((v, i) => i === 0 || v >= (values[i - 1] ?? 0)),
    `progress went backwards: ${values.join(', ')}`,
  ).toBe(true);
  expect(Math.max(...values)).toBeGreaterThan(Math.min(...values));
  expect(values.every((v) => v >= 0 && v <= 100)).toBe(true);
}

test.describe('loading screen', () => {
  test('covers the first load, reports rising progress and hands over to the tank', async ({
    page,
  }) => {
    await recordProgress(page);
    await page.goto('/?backend=webgl&tier=low&e2e', { waitUntil: 'domcontentloaded' });

    await expect(bar(page)).toBeVisible({ timeout: LOAD_MS });
    await expect(bar(page)).toHaveAttribute('aria-valuemin', '0');
    await expect(bar(page)).toHaveAttribute('aria-valuemax', '100');
    await expect(bar(page)).toHaveAccessibleName(/Loading the aquarium/);
    await expect(page.locator('.loading-stage')).toHaveText(/\w/);

    await expect(bar(page)).toBeHidden({ timeout: LOAD_MS });
    await expect(page.locator('#app')).toHaveAttribute('data-scene-biome', 'freshwater');
    await expect(page.locator('canvas#tank')).toHaveAttribute('data-fish-species', /\w/);
    expectRising(await recorded(page));
  });

  test('comes back on a tank switch and leaves once the new tank has rendered', async ({
    page,
  }) => {
    await recordProgress(page);
    await page.goto('/?backend=webgl&tier=low&e2e', { waitUntil: 'domcontentloaded' });
    await awaitLoaded(page, LOAD_MS);
    await expect(page.locator('#app')).toHaveAttribute('data-scene-biome', 'freshwater');
    await page.evaluate(() => {
      window.__loadValues = [];
    });

    await page
      .getByRole('group', { name: 'Tank type' })
      .getByRole('button', { name: 'Reef', exact: true })
      .click();
    await expect(bar(page)).toBeVisible({ timeout: LOAD_MS });
    await expect(bar(page)).toHaveAccessibleName(/Loading the tank/);
    await expect(bar(page)).toBeHidden({ timeout: LOAD_MS });
    await expect(page.locator('#app')).toHaveAttribute('data-scene-biome', 'reef');
    expectRising(await recorded(page));
  });

  test('shows an error with a retry instead of hanging, and the retry loads', async ({ page }) => {
    await page.route('**/assets/index.json', () => undefined, { times: 1 });
    await page.goto('/?backend=webgl&tier=low&e2e&loadStallMs=4000', {
      waitUntil: 'domcontentloaded',
    });

    const alert = page.getByRole('alert').filter({ hasText: /taking longer than expected/ });
    await expect(alert).toBeVisible({ timeout: 60_000 });
    await expect(bar(page)).toHaveCount(0);
    const retry = page.getByRole('button', { name: 'Try again' });
    await expect(retry).toBeFocused();

    await page.evaluate(() =>
      window.history.replaceState(null, '', '/?backend=webgl&tier=low&e2e'),
    );
    await retry.click();
    await expect(page.locator('#app')).toHaveAttribute('data-scene-biome', 'freshwater', {
      timeout: LOAD_MS,
    });
    await awaitLoaded(page, LOAD_MS);
    await expect(alert).toHaveCount(0);
  });

  test('clears the error card when the stalled load finishes later', async ({ page }) => {
    let held: Route | undefined;
    await page.route(
      '**/assets/index.json',
      (route) => {
        held = route;
      },
      { times: 1 },
    );
    await page.goto('/?backend=webgl&tier=low&e2e&loadStallMs=4000', {
      waitUntil: 'domcontentloaded',
    });

    const alert = page.getByRole('alert').filter({ hasText: /taking longer than expected/ });
    await expect(alert).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => held !== undefined).toBe(true);
    await held?.continue();

    await awaitLoaded(page, LOAD_MS);
    await expect(alert).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(page.locator('#app')).toHaveAttribute('data-scene-biome', 'freshwater');
  });

  test('closes the error card with Dismiss and leaves the page usable', async ({ page }) => {
    await page.route('**/assets/index.json', () => undefined);
    await page.goto('/?backend=webgl&tier=low&e2e&loadStallMs=4000', {
      waitUntil: 'domcontentloaded',
    });

    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Dismiss' }).click();

    await expect(page.locator('.loading')).toHaveCount(0);
    await expect(page.locator('[inert]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Account/ })).toBeEnabled();
  });

  test('fits a phone screen', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await page.route('**/assets/index.json', () => undefined);
    await page.goto('/?backend=webgl&tier=low&e2e&loadStallMs=4000', {
      waitUntil: 'domcontentloaded',
    });
    const retry = page.getByRole('button', { name: 'Try again' });
    await expect(retry).toBeVisible({ timeout: 60_000 });
    await expect(retry).toBeInViewport({ ratio: 1 });
    const box = await retry.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await context.close();
  });
});
