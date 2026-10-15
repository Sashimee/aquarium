import { expect, type Locator, type Page } from '@playwright/test';

export const APP_URL = `http://localhost:${process.env['E2E_PORT'] ?? 4317}`;

export const PASSWORD = 'a long enough passphrase 9';
export const SCENE_TIMEOUT_MS = 180_000;

let counter = 0;

export function newIdentity(label: string): { name: string; email: string } {
  counter += 1;
  const tag = `${label}${Date.now().toString(36)}${counter}`;
  return { name: `E2E ${label}`, email: `e2e-${tag}@bas.lu` };
}

interface SinkMessage {
  to: string;
  subject: string;
  text: string;
}

async function outboxFor(email: string): Promise<SinkMessage[]> {
  const res = await fetch(`${APP_URL}/__e2e/outbox`);
  const all = (await res.json()) as SinkMessage[];
  return all.filter((m) => m.to.toLowerCase() === email.toLowerCase());
}

export async function verificationLinkFor(email: string): Promise<string> {
  let link = '';
  await expect
    .poll(
      async () => {
        const mail = (await outboxFor(email)).find((m) => /verify/i.test(m.subject));
        link = mail ? (/<(https?:\/\/[^>\s]+)>/.exec(mail.text)?.[1] ?? '') : '';
        return link;
      },
      { message: `a verification email for ${email} in the test outbox` },
    )
    .not.toBe('');
  return link;
}

/** Signs up through the API and follows the mailed link in the page's own browser context. */
export async function registerVerifiedUser(
  page: Page,
  label: string,
): Promise<{ name: string; email: string }> {
  const identity = newIdentity(label);
  const signUp = await page.request.post('/api/auth/sign-up/email', {
    headers: { origin: APP_URL },
    data: { ...identity, password: PASSWORD, callbackURL: '/verify-email' },
  });
  expect(signUp.ok(), 'sign-up request').toBe(true);
  const verified = await page.request.get(await verificationLinkFor(identity.email));
  expect(verified.ok(), 'verification link').toBe(true);
  return identity;
}

export const dockButton = (page: Page, label: string): Locator =>
  page
    .getByRole('navigation', { name: 'Actions' })
    .getByRole('button', { name: label, exact: true });

export const loadingOverlay = (page: Page): Locator => page.locator('.loading');

/**
 * The loading overlay is modal and covers the whole page until the tank has drawn its first
 * frames, so nothing can be pressed before it is gone. It only shows after 150 ms, so wait for
 * the scene first: by then it is certainly up.
 */
export async function awaitLoaded(page: Page, timeout = SCENE_TIMEOUT_MS): Promise<void> {
  await expect(page.locator('#app')).toHaveAttribute('data-scene-biome', /\w/, { timeout });
  await expect(loadingOverlay(page)).toHaveCount(0, { timeout });
}

/** `e2e` also exposes the camera pose, swimming species and sim colliders on the canvas. */
export async function openTank(page: Page, { e2e = false } = {}): Promise<void> {
  await page.goto(e2e ? '/?tier=low&backend=webgl&e2e' : '/?tier=low&backend=webgl');
  await awaitLoaded(page);
  await expect(dockButton(page, 'Feed')).toBeEnabled({ timeout: SCENE_TIMEOUT_MS });
}

async function open(button: Locator, attribute: string, region: Locator): Promise<Locator> {
  if ((await button.getAttribute(attribute)) !== 'true') await button.click();
  await expect(region).toBeVisible();
  return region;
}

export function openDock(page: Page, label: string, region: string): Promise<Locator> {
  return open(dockButton(page, label), 'aria-expanded', page.getByRole('region', { name: region }));
}

export function openTankPanel(page: Page): Promise<Locator> {
  return open(
    page.getByRole('button', { name: 'My tank' }),
    'aria-expanded',
    page.getByRole('region', { name: 'Your tank' }),
  );
}

export function openReport(page: Page): Promise<Locator> {
  return open(
    page.getByRole('button', { name: 'Tank report' }),
    'aria-expanded',
    page.getByRole('region', { name: 'Tank report' }),
  );
}

export async function openAccount(page: Page): Promise<Locator> {
  const avatar = page.getByRole('button', { name: /^Account/ });
  await expect(avatar).toBeEnabled();
  await open(avatar, 'aria-expanded', page.getByRole('region', { name: 'Account menu' }));
  return page.getByRole('navigation', { name: 'Account' });
}

export async function createFirstTank(page: Page): Promise<void> {
  await openTankPanel(page);
  await page.getByRole('button', { name: 'Create tank' }).click();
  await expect(page.getByRole('heading', { name: 'Tanks' })).toBeVisible();
}

export interface TankView {
  id: string;
  name: string;
  water: { uneatenFood: number; ammonia: number; algae: number };
  decorLayout: { assetId: string; position: number[]; rotationY: number }[];
  decorEdited: boolean;
  fish: { id: string; name: string; status: 'alive' | 'dead' }[];
  memorials: { fishName: string }[];
}

export async function savedTanks(page: Page): Promise<TankView[]> {
  const res = await page.request.get('/api/tanks');
  expect(res.ok(), 'GET /api/tanks').toBe(true);
  return (await res.json()) as TankView[];
}

export async function advanceServerClock(page: Page, minutes: number): Promise<void> {
  const res = await page.request.post('/api/test/advance-time', {
    data: { minutes },
    headers: { origin: APP_URL },
  });
  expect(res.status(), 'advance-time (the e2e server enables test hooks)').toBe(204);
}

/**
 * Moves the page's own clock past the refresh throttle and fires the visibility event a returning
 * tab would, so the app asks the server what happened instead of booting the scene again.
 */
export async function returnToTab(page: Page, awayMinutes: number): Promise<void> {
  await page.evaluate((ms) => {
    const w = window as unknown as { __realNow?: () => number };
    const realNow = (w.__realNow ??= Date.now.bind(Date));
    Date.now = () => realNow() + ms;
    document.dispatchEvent(new Event('visibilitychange'));
  }, awayMinutes * 60_000);
}
