import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  APP_URL,
  PASSWORD,
  awaitLoaded,
  createFirstTank,
  dockButton,
  openDock,
  openTank,
  openTankPanel,
  registerVerifiedUser,
} from '../support/app.ts';

const VIEW_QUERY = 'tier=low&backend=webgl';

async function freshVisitor(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    baseURL: APP_URL,
    viewport: { width: 800, height: 540 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  return context.newPage();
}

async function openLink(page: Page, link: string): Promise<void> {
  await page.goto(`${link}?${VIEW_QUERY}`);
}

const heart = (page: Page) => page.getByRole('button', { name: /^Heart,/ });
const star = (page: Page) => page.getByRole('button', { name: /^Star,/ });

test('share, view read-only, react, rotate and revoke a public link', async ({ page, browser }) => {
  test.setTimeout(600_000);
  await registerVerifiedUser(page, 'owner');
  await openTank(page);
  await createFirstTank(page);
  await openDock(page, 'Shop', 'Fish shop');
  await page.getByLabel('Name for the new fish').fill('Sprite');
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await expect(page.getByRole('region', { name: 'Fish in bags' })).toContainText('Sprite');

  const panel = await openTankPanel(page);
  await panel.getByRole('button', { name: 'Create a public link' }).click();
  const linkField = panel.getByLabel('Public link');
  await expect(linkField).toHaveValue(/\/t\/[A-Za-z0-9_-]{43}$/);
  await expect(panel).toContainText('only time the link is shown');
  const link = await linkField.inputValue();
  expect(new URL(link).origin).toBe(APP_URL);

  await page.goto('about:blank');
  const visitor = await freshVisitor(browser);
  await openLink(visitor, link);
  await awaitLoaded(visitor);

  await expect(visitor.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(visitor.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    'noindex, nofollow',
  );
  await expect(visitor.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  await expect(visitor.getByRole('main')).toBeVisible();
  await expect(dockButton(visitor, 'Feed')).toHaveCount(0);
  await expect(visitor.getByRole('navigation', { name: 'Actions' })).toHaveCount(0);
  await expect(visitor.getByRole('button', { name: 'My tank' })).toHaveCount(0);
  await visitor.getByText('Tank report', { exact: true }).click();
  await expect(visitor.locator('.public-report')).toContainText('Sprite the');
  await expect(visitor.locator('body')).not.toContainText('@bas.lu');

  const apiView = await visitor.request.get(`/api/public/${link.split('/').pop()}`);
  expect(apiView.status()).toBe(200);
  expect(apiView.headers()['x-robots-tag']).toContain('noindex');
  expect(apiView.headers()['cache-control']).toContain('no-store');

  await heart(visitor).click();
  await expect(visitor.getByRole('status').filter({ hasText: 'Sign in' })).toBeVisible();

  const viewer = await registerVerifiedUser(visitor, 'viewer');
  await visitor.context().clearCookies();
  await openLink(visitor, link);
  await awaitLoaded(visitor);
  await heart(visitor).click();
  await visitor.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(visitor).toHaveURL(/\/sign-in(\?|$)/);
  await visitor.getByLabel('Email').fill(viewer.email);
  await visitor.getByLabel('Password').fill(PASSWORD);
  await visitor.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(visitor).toHaveURL(new RegExp(`/t/${link.split('/').pop()}`), { timeout: 120_000 });
  expect(visitor.url()).not.toContain('next=');
  await awaitLoaded(visitor);
  await heart(visitor).click();
  await expect(heart(visitor)).toHaveAccessibleName('Heart, 1 reaction, your choice');
  await expect(heart(visitor)).toHaveAttribute('aria-pressed', 'true');
  await star(visitor).click();
  await expect(star(visitor)).toHaveAccessibleName('Star, 1 reaction, your choice');
  await expect(heart(visitor)).toHaveAccessibleName('Heart, 0 reactions');
  await star(visitor).click();
  await expect(star(visitor)).toHaveAccessibleName('Star, 0 reactions');
  await heart(visitor).click();
  await expect(heart(visitor)).toHaveAttribute('aria-pressed', 'true');

  await visitor.goto('about:blank');
  await openTank(page);
  const reopened = await openTankPanel(page);
  await expect(reopened.getByLabel('Public link')).toHaveCount(0);
  await expect(reopened).toContainText('the link is not stored');
  await reopened.getByRole('button', { name: 'Get a new link' }).click();
  await reopened.getByRole('button', { name: 'Yes, get a new link' }).click();
  const fresh = await reopened.getByLabel('Public link').inputValue();
  expect(fresh).not.toBe(link);

  await page.goto('about:blank');
  await openLink(visitor, link);
  await expect(visitor.locator('#public-notice-h')).toHaveText('Tank not found', {
    timeout: 120_000,
  });
  await expect(visitor.locator('main')).toContainText('not shared any more');

  await openLink(visitor, fresh);
  await awaitLoaded(visitor);
  await expect(heart(visitor)).toHaveAccessibleName('Heart, 1 reaction, your choice');
  await visitor.goto('about:blank');

  await openTank(page);
  const again = await openTankPanel(page);
  await again.getByRole('button', { name: 'Stop sharing' }).click();
  await again.getByRole('button', { name: 'Yes, stop sharing' }).click();
  await expect(again.getByRole('button', { name: 'Create a public link' })).toBeVisible();
  await page.goto('about:blank');

  const gone = await visitor.request.get(`/api/public/${fresh.split('/').pop()}`);
  expect(gone.status()).toBe(404);
  await openLink(visitor, fresh);
  await expect(visitor.locator('#public-notice-h')).toHaveText('Tank not found', {
    timeout: 120_000,
  });
  const late = await visitor.request.put(`/api/public/${fresh.split('/').pop()}/reaction`, {
    data: { kind: 'wow' },
    headers: { origin: APP_URL },
  });
  expect(late.status()).toBe(404);

  await visitor.context().close();
});

test('an owner cannot react to their own shared tank', async ({ page }) => {
  await registerVerifiedUser(page, 'selfie');
  await openTank(page);
  await createFirstTank(page);
  const panel = await openTankPanel(page);
  await panel.getByRole('button', { name: 'Create a public link' }).click();
  const link = await panel.getByLabel('Public link').inputValue();

  await openLink(page, link);
  await awaitLoaded(page);
  await heart(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'your own tank' })).toBeVisible();
  await expect(heart(page)).toHaveAccessibleName('Heart, 0 reactions');
});

test('a malformed or unknown link shows one friendly message', async ({ page }) => {
  await page.goto('/t/definitelynotatoken');
  await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible({
    timeout: 120_000,
  });
  await page.goto(`/t/${'x'.repeat(43)}?${VIEW_QUERY}`);
  await expect(page.getByRole('heading', { name: 'Tank not found' })).toBeVisible({
    timeout: 120_000,
  });
});
