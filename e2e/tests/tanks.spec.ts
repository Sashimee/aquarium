import { expect, test } from '@playwright/test';
import {
  createFirstTank,
  openDock,
  openReport,
  openTank,
  openTankPanel,
  registerVerifiedUser,
  savedTanks,
} from '../support/app.ts';

test('switching tanks swaps the fish and keeps both saved', async ({ page }) => {
  await registerVerifiedUser(page, 'tanks');
  await openTank(page);
  await openTankPanel(page);
  const firstName = await page.getByLabel('Tank name').inputValue();
  await createFirstTank(page);

  await expect(await openReport(page)).toContainText(`${firstName}, a freshwater tank.`);

  await openTankPanel(page);
  await page.getByRole('button', { name: 'New tank' }).click();
  await page.getByLabel('Tank name').fill('Second tank');
  await page.getByRole('button', { name: 'Create tank' }).click();
  await expect(page.locator('.life-status')).toContainText('Second tank is ready.');
  const switcher = page.getByLabel('Active tank');
  await expect(switcher.locator('option')).toHaveCount(2);
  await expect(await openReport(page)).toContainText('Second tank, a freshwater tank.');

  await openDock(page, 'Shop', 'Fish shop');
  await page.getByLabel('Name for the new fish').fill('Sprite');
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await expect(await openReport(page)).toContainText('Sprite');

  await openTankPanel(page);
  await switcher.selectOption({ label: `${firstName} (Freshwater, Standard 300 L)` });
  const report = await openReport(page);
  await expect(report).toContainText(`${firstName}, a freshwater tank.`);
  await expect(report).toContainText('No fish are alive in this tank.');

  await openTankPanel(page);
  await switcher.selectOption({ label: 'Second tank (Freshwater, Standard 300 L)' });
  await expect(await openReport(page)).toContainText('1 fish alive: Sprite');

  const tanks = await savedTanks(page);
  expect(tanks.map((t) => t.name).sort()).toEqual([firstName, 'Second tank'].sort());
  expect(tanks.find((t) => t.name === 'Second tank')?.fish).toMatchObject([{ name: 'Sprite' }]);
  expect(tanks.find((t) => t.name === firstName)?.fish).toEqual([]);
});
