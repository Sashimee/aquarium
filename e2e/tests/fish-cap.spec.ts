import { expect, test } from '@playwright/test';
import { openDock, openTank, registerVerifiedUser } from '../support/app.ts';
import { addFish, addFishRaw, createTank, errorOf, getTank, wallet } from '../support/api.ts';

test('a nano tank takes 12 animals, refuses the 13th without charging, and the shop says why', async ({
  page,
}) => {
  test.setTimeout(420_000);
  await registerVerifiedUser(page, 'cap');
  const nano = await createTank(page, { name: 'Tiny', size: 'nano30' });

  for (let n = 1; n <= 12; n += 1)
    await addFish(page, nano.id, 'cherry-shrimp', { name: `Shrimp ${n}` });
  expect((await getTank(page, nano.id)).fish).toHaveLength(12);
  const chargedBefore = (await wallet(page)).ledger.filter((r) =>
    r.itemRef?.startsWith('species:'),
  );
  expect(chargedBefore).toHaveLength(12);

  const refused = await addFishRaw(page, nano.id, 'cherry-shrimp', { name: 'One too many' });
  expect(refused.status()).toBe(409);
  expect((await errorOf(refused)).message).toContain('at capacity');
  expect((await getTank(page, nano.id)).fish).toHaveLength(12);
  const chargedAfter = (await wallet(page)).ledger.filter((r) => r.itemRef?.startsWith('species:'));
  expect(chargedAfter).toHaveLength(12);

  await openTank(page);
  const shop = await openDock(page, 'Shop', 'Fish shop');
  await expect(shop).toContainText('12 of 12 animals');
  await expect(
    shop.getByText(/This tank is full: it holds at most 12 animals/).first(),
  ).toBeVisible();
  for (const button of await shop.getByRole('button', { name: 'Add', exact: true }).all()) {
    await expect(button).toBeDisabled();
  }
});

test('a standard tank is capped at 60 animals', async ({ page }) => {
  test.setTimeout(420_000);
  await registerVerifiedUser(page, 'capstd');
  await createTank(page, { name: 'Big' });
  await openTank(page);
  const shop = await openDock(page, 'Shop', 'Fish shop');
  await expect(shop).toContainText('0 of 60 animals');
});
