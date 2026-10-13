import { expect } from '@playwright/test';
import { test } from '../support/test.ts';
import { createFirstTank, openTank, registerVerifiedUser, savedTanks } from '../support/app.ts';

test('switching tanks swaps the fish and keeps both saved', async ({ page }) => {
  await registerVerifiedUser(page, 'tanks');
  await openTank(page);
  await page.getByRole('button', { name: 'My tank' }).click();
  const firstName = await page.getByLabel('Tank name').inputValue();
  await createFirstTank(page);

  const switcher = page.getByLabel('Active tank');
  const report = page.getByRole('region', { name: 'Tank report' });
  await page.getByRole('button', { name: 'Tank report' }).click();
  await expect(report).toContainText(`${firstName}, a freshwater tank.`);

  await page.getByRole('button', { name: 'New tank' }).click();
  await page.getByLabel('Tank name').fill('Second tank');
  await page.getByRole('button', { name: 'Create tank' }).click();
  await expect(page.locator('.life-status')).toContainText('Second tank is ready.');
  await expect(switcher.locator('option')).toHaveCount(2);
  await expect(report).toContainText('Second tank, a freshwater tank.');

  await page.getByLabel('Name for the new fish').fill('Sprite');
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await expect(report).toContainText('Sprite');

  await switcher.selectOption({ label: `${firstName} (Freshwater)` });
  await expect(report).toContainText(`${firstName}, a freshwater tank.`);
  await expect(report).toContainText('No fish are alive in this tank.');

  await switcher.selectOption({ label: 'Second tank (Freshwater)' });
  await expect(report).toContainText('1 fish alive: Sprite');

  const tanks = await savedTanks(page);
  expect(tanks.map((t) => t.name).sort()).toEqual([firstName, 'Second tank'].sort());
  expect(tanks.find((t) => t.name === 'Second tank')?.fish).toMatchObject([{ name: 'Sprite' }]);
  expect(tanks.find((t) => t.name === firstName)?.fish).toEqual([]);
});
