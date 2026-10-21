import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  APP_URL,
  PASSWORD,
  awaitLoaded,
  dockButton,
  openTank,
  openTankPanel,
  registerVerifiedUser,
} from '../support/app.ts';

const VIEW_QUERY = 'tier=low&backend=webgl';
const post = { headers: { origin: APP_URL } };

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

const tokenOf = (link: string): string => link.split('/').pop() ?? '';

const heart = (page: Page) => page.getByRole('button', { name: /^Heart,/ });
const star = (page: Page) => page.getByRole('button', { name: /^Star,/ });

async function createTank(page: Page): Promise<string> {
  const created = await page.request.post('/api/tanks', {
    ...post,
    data: { name: 'Pond', biome: 'freshwater', idempotencyKey: crypto.randomUUID() },
  });
  expect(created.status(), 'create tank').toBe(201);
  const { id } = (await created.json()) as { id: string };
  const fish = await page.request.post(`/api/tanks/${id}/fish`, {
    ...post,
    data: {
      species: 'betta',
      name: 'Sprite',
      stage: 'juvenile',
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(fish.ok(), 'add fish').toBe(true);
  return id;
}

async function shareTank(page: Page, tankId: string): Promise<string> {
  const shared = await page.request.post(`/api/tanks/${tankId}/share`, post);
  expect(shared.ok(), 'enable sharing').toBe(true);
  const { shareToken } = (await shared.json()) as { shareToken: string };
  return `${APP_URL}/t/${shareToken}`;
}

test('the owner shares, rotates and stops sharing from the tank panel', async ({ page }) => {
  test.setTimeout(240_000);
  await registerVerifiedUser(page, 'owner');
  await createTank(page);
  await openTank(page);

  const panel = await openTankPanel(page);
  await panel.getByRole('button', { name: 'Create a public link' }).click();
  const linkField = panel.getByLabel('Public link');
  await expect(linkField).toHaveValue(/\/t\/[A-Za-z0-9_-]{43}$/);
  await expect(panel).toContainText('only time the link is shown');
  const link = await linkField.inputValue();
  expect(new URL(link).origin).toBe(APP_URL);
  expect((await page.request.get(`/api/public/${tokenOf(link)}`)).status()).toBe(200);

  await panel.getByRole('button', { name: 'Replace the link' }).click();
  await panel.getByRole('button', { name: 'Yes, get a new link' }).click();
  await expect(panel.getByLabel('Public link')).not.toHaveValue(link);
  const fresh = await panel.getByLabel('Public link').inputValue();
  expect((await page.request.get(`/api/public/${tokenOf(link)}`)).status()).toBe(404);
  expect((await page.request.get(`/api/public/${tokenOf(fresh)}`)).status()).toBe(200);

  await panel.getByRole('button', { name: 'Stop sharing' }).click();
  await panel.getByRole('button', { name: 'Yes, stop sharing' }).click();
  await expect(panel.getByRole('button', { name: 'Create a public link' })).toBeVisible();
  expect((await page.request.get(`/api/public/${tokenOf(fresh)}`)).status()).toBe(404);
  const late = await page.request.put(`/api/public/${tokenOf(fresh)}/reaction`, {
    ...post,
    data: { kind: 'wow' },
  });
  expect(late.status()).toBe(404);

  await page.goto('about:blank');
  await openLink(page, link);
  await expect(page.locator('#public-notice-h')).toHaveText('Tank not found', {
    timeout: 120_000,
  });
  await expect(page.locator('main')).toContainText('not shared any more');
});

test('a visitor sees a read-only, private, noindex tank', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await registerVerifiedUser(page, 'owner');
  const tankId = await createTank(page);
  const emptied = await page.request.patch(`/api/tanks/${tankId}`, {
    ...post,
    data: { decorLayout: [] },
  });
  expect(emptied.ok(), 'save an emptied decor layout').toBe(true);
  const link = await shareTank(page, tankId);

  const visitor = await freshVisitor(browser);
  const view = await visitor.request.get(`/api/public/${tokenOf(link)}`);
  expect(view.status()).toBe(200);
  expect(view.headers()['x-robots-tag']).toContain('noindex');
  expect(view.headers()['cache-control']).toContain('no-store');
  expect(await view.json()).toMatchObject({ decorEdited: true, decorLayout: [] });

  await openLink(visitor, link);
  await awaitLoaded(visitor);
  await expect(visitor.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(visitor.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    'noindex, nofollow',
  );
  await expect(visitor.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  await expect(visitor.locator('main')).toHaveCount(1);
  await expect(dockButton(visitor, 'Feed')).toHaveCount(0);
  await expect(visitor.getByRole('navigation', { name: 'Actions' })).toHaveCount(0);
  await expect(visitor.getByRole('button', { name: 'My tank' })).toHaveCount(0);
  await visitor.getByText('Tank report', { exact: true }).click();
  await expect(visitor.locator('.public-report')).toContainText('Sprite the');
  await expect(visitor.locator('body')).not.toContainText('@bas.lu');
  await visitor.context().close();
});

test('a visitor signs in or signs up, returns to the link and reacts', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  await registerVerifiedUser(page, 'owner');
  const link = await shareTank(page, await createTank(page));

  const visitor = await freshVisitor(browser);
  const viewer = await registerVerifiedUser(visitor, 'viewer');
  await visitor.context().clearCookies();
  const returnTo = `/t/${tokenOf(link)}`;

  await openLink(visitor, link);
  await awaitLoaded(visitor);
  await heart(visitor).click();
  await expect(visitor.getByRole('status').filter({ hasText: 'Sign in' })).toBeVisible();

  await visitor.getByRole('link', { name: 'create an account', exact: true }).click();
  await expect(visitor).toHaveURL(/\/sign-up(\?|$)/);
  expect(await visitor.evaluate(() => history.state)).toEqual({ returnTo });
  await visitor.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(visitor).toHaveURL(/\/sign-in(\?|$)/);
  expect(await visitor.evaluate(() => history.state)).toEqual({ returnTo });
  expect(visitor.url()).not.toContain(tokenOf(link));

  await visitor.getByLabel('Email').fill(viewer.email);
  await visitor.getByLabel('Password').fill(PASSWORD);
  await visitor.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(visitor).toHaveURL(new RegExp(`/t/${tokenOf(link)}`), { timeout: 120_000 });
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
  await visitor.context().close();
});

test('an owner cannot react to their own shared tank', async ({ page }) => {
  test.setTimeout(240_000);
  await registerVerifiedUser(page, 'selfie');
  const link = await shareTank(page, await createTank(page));

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
