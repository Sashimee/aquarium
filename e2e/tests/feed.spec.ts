import { expect, test } from '@playwright/test';
import { createFirstTank, openTank, registerVerifiedUser, savedTanks } from '../support/app.ts';

test('hand-feeding drops food and the server records it', async ({ page }) => {
  await registerVerifiedUser(page, 'feed');
  await openTank(page);
  await createFirstTank(page);
  await expect.poll(async () => (await savedTanks(page)).length).toBe(1);
  expect((await savedTanks(page))[0]?.water.uneatenFood).toBe(0);

  await page.getByRole('button', { name: 'Feed', exact: true }).click();

  await expect(page.getByText('Fed flakes.')).toBeVisible();
  await expect
    .poll(async () => (await savedTanks(page))[0]?.water.uneatenFood, {
      message: 'the server counts the dropped food as uneaten',
    })
    .toBeGreaterThan(0);

  await page.getByLabel('Food').selectOption('pellets');
  await page.getByRole('button', { name: 'Feed', exact: true }).click();
  await expect(page.getByText(/Fed pellets\.|Feeding too often/)).toBeVisible();
});
