import { expect, test, type Page } from '@playwright/test';
import {
  awaitLoaded,
  dockButton,
  openDock,
  openTankPanel,
  registerVerifiedUser,
  SCENE_TIMEOUT_MS,
} from '../support/app.ts';

const FISH_START_MS = 90_000;

async function openScene(page: Page): Promise<void> {
  await page.goto('/?tier=low&backend=webgl&e2e');
  await awaitLoaded(page);
  await expect(dockButton(page, 'Feed')).toBeEnabled({ timeout: SCENE_TIMEOUT_MS });
}

async function createTank(page: Page, kind: 'Freshwater' | 'Reef', name: string): Promise<void> {
  await openTankPanel(page);
  const newTank = page.getByRole('button', { name: 'New tank' });
  if (await newTank.isVisible()) await newTank.click();
  await page.getByLabel('Kind of tank').selectOption({ label: kind });
  await page.getByLabel('Tank name').fill(name);
  await page.getByRole('button', { name: 'Create tank' }).click();
  await expect(page.locator('.life-status')).toContainText(`${name} is ready.`);
}

async function buyShrimp(page: Page, commonName: string, fishName: string): Promise<void> {
  const shop = await openDock(page, 'Shop', 'Fish shop');
  await page.getByLabel('Name for the new fish').fill(fishName);
  await shop
    .getByRole('listitem')
    .filter({ hasText: commonName })
    .getByRole('button', { name: 'Add', exact: true })
    .click();
  await expect(page.locator('.life-status')).toContainText(`${fishName} is in a bag`);
  const release = page.getByRole('button', { name: `Release ${fishName} now` });
  // The bag releases itself after the acclimation, which removes the button; a click delayed past
  // that point on a loaded runner has nothing left to hit, and the fish is already free.
  await expect(async () => {
    if ((await release.count()) === 0) return;
    await release.click({ timeout: 5_000 });
  }).toPass({ timeout: FISH_START_MS });
}

const swimming = async (page: Page): Promise<string[]> => {
  const value = await page.locator('canvas#tank').getAttribute('data-fish-species');
  return value === null || value === '' ? [] : value.split(',');
};

test('cherry shrimp are sold for freshwater and cleaner shrimp for reef only', async ({ page }) => {
  await registerVerifiedUser(page, 'shrimp');
  await openScene(page);

  await createTank(page, 'Freshwater', 'Shrimp pond');
  const shop = await openDock(page, 'Shop', 'Fish shop');
  await expect(shop.getByRole('listitem').filter({ hasText: 'Cherry shrimp' })).toHaveCount(1);
  await expect(shop.getByText('Cleaner shrimp')).toHaveCount(0);
  await buyShrimp(page, 'Cherry shrimp', 'Ruby');
  await expect
    .poll(() => swimming(page), { timeout: FISH_START_MS, message: 'a cherry shrimp swims' })
    .toContain('cherry-shrimp');

  await createTank(page, 'Reef', 'Shrimp reef');
  const reefShop = await openDock(page, 'Shop', 'Fish shop');
  await expect(reefShop.getByRole('listitem').filter({ hasText: 'Cleaner shrimp' })).toHaveCount(1);
  await expect(reefShop.getByText('Cherry shrimp')).toHaveCount(0);
  await buyShrimp(page, 'Cleaner shrimp', 'Scarlet');
  await expect
    .poll(() => swimming(page), { timeout: FISH_START_MS, message: 'a cleaner shrimp swims' })
    .toContain('cleaner-shrimp');
});
