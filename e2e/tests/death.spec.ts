import { expect, test } from '@playwright/test';
import {
  advanceServerClock,
  createFirstTank,
  openDock,
  openReport,
  openTank,
  registerVerifiedUser,
  savedTanks,
} from '../support/app.ts';

const THIRTY_DAYS_IN_MINUTES = 30 * 24 * 60;

test('a fish that starves while you are away is reported, netted and remembered', async ({
  page,
}) => {
  await registerVerifiedUser(page, 'death');
  await openTank(page);
  await createFirstTank(page);
  await openDock(page, 'Shop', 'Fish shop');
  await page.getByLabel('Name for the new fish').fill('Biscuit');
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await expect(page.getByRole('region', { name: 'Fish in bags' })).toContainText('Biscuit');
  expect((await savedTanks(page))[0]?.fish).toMatchObject([{ name: 'Biscuit', status: 'alive' }]);

  await advanceServerClock(page, THIRTY_DAYS_IN_MINUTES);
  await openTank(page);

  const away = page.getByRole('dialog', { name: 'We are sorry' });
  await expect(away).toContainText('One fish died while you were gone.');
  await expect(away).toContainText('Biscuit');
  await expect(away).toContainText('went too long without food');
  expect((await savedTanks(page))[0]?.fish).toMatchObject([{ name: 'Biscuit', status: 'dead' }]);

  await away.getByRole('button', { name: 'See the fish to net' }).click();
  await expect(away).toBeHidden();
  await expect(page.getByRole('region', { name: 'Fish that have died' })).toBeVisible();
  await page.getByRole('button', { name: 'Net Biscuit' }).click();

  const confirm = page.getByRole('dialog', { name: 'Net Biscuit?' });
  await confirm.getByRole('button', { name: 'Net Biscuit' }).click();
  await expect(page.locator('.life-status')).toContainText('Biscuit was netted');
  await expect(page.getByRole('region', { name: 'Memorial' })).toContainText('Biscuit');
  await expect(page.getByRole('region', { name: 'Fish that have died' })).toBeHidden();

  const [tank] = await savedTanks(page);
  expect(tank?.fish).toEqual([]);
  expect(tank?.memorials).toMatchObject([{ fishName: 'Biscuit' }]);

  await expect(await openReport(page)).toContainText('No fish are alive in this tank.');
});
