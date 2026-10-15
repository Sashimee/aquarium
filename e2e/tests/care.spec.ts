import { expect, test } from '@playwright/test';
import {
  createFirstTank,
  openDock,
  openTank,
  registerVerifiedUser,
  savedTanks,
} from '../support/app.ts';

test('shop, acclimation bag and the three chores', async ({ page }) => {
  await registerVerifiedUser(page, 'care');
  await openTank(page);
  await createFirstTank(page);
  const status = page.locator('.life-status');

  await openDock(page, 'Shop', 'Fish shop');
  await page.getByLabel('Name for the new fish').fill('Pip');
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await expect(status).toContainText('Pip is in a bag, getting used to the water.');
  const bag = page.getByRole('region', { name: 'Fish in bags' });
  await expect(bag).toContainText('Pip');
  expect((await savedTanks(page))[0]?.fish).toMatchObject([{ name: 'Pip', status: 'alive' }]);

  await bag.getByRole('button', { name: 'Release Pip now' }).click();
  await expect(bag).toBeHidden();

  await openDock(page, 'Feed', 'Feed the fish');
  await page.getByRole('button', { name: 'Drop food' }).click();
  await expect.poll(async () => (await savedTanks(page))[0]?.water.uneatenFood).toBeGreaterThan(0);

  await openDock(page, 'Care', 'Care');
  await page.getByRole('button', { name: /^Vacuum the gravel/ }).click();
  await expect(status).toContainText('The gravel is clean.');
  expect((await savedTanks(page))[0]?.water.uneatenFood).toBe(0);

  await page.getByRole('button', { name: 'Change half the water' }).click();
  await expect(status).toContainText('Half the water was changed.');

  await page.getByRole('button', { name: 'Scrape the glass' }).click();
  await expect(status).toContainText('The glass is clear.');
});
