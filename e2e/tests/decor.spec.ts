import { expect, type Page } from '@playwright/test';
import { test } from '../support/test.ts';
import { createFirstTank, openTank, registerVerifiedUser, savedTanks } from '../support/app.ts';

async function startDecorating(page: Page) {
  const panel = page.getByRole('region', { name: 'Decorate the tank' });
  const tankPanel = page.getByRole('region', { name: 'Your tank' });
  if (await tankPanel.isVisible()) await tankPanel.getByRole('button', { name: 'Close' }).click();
  // The editor attaches a moment after the tank is ready, and a request before then is dropped.
  await expect(async () => {
    const toggle = page.getByRole('button', { name: 'Decorate' });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
    await expect(panel).toBeVisible({ timeout: 5_000 });
  }).toPass();
  return panel;
}

test('a decor piece is added, moved, saved and still there after a reload', async ({ page }) => {
  await registerVerifiedUser(page, 'decor');
  await openTank(page);
  await createFirstTank(page);
  expect((await savedTanks(page))[0]?.decorLayout).toEqual([]);

  const panel = await startDecorating(page);
  const add = panel.getByRole('button', { name: /^Add (?!Vacation feeder)/ }).first();
  const label = (await add.innerText()).replace(/^Add /, '');
  await add.click();
  const piece = panel.locator('.decor-pieces').getByRole('button', { name: label });
  await piece.click();
  await expect(piece).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByText('Layout saved.')).toBeVisible();
  const placed = (await savedTanks(page))[0]?.decorLayout;
  expect(placed).toHaveLength(1);

  await panel.getByRole('button', { name: 'Right', exact: true }).click();
  await expect
    .poll(async () => (await savedTanks(page))[0]?.decorLayout[0]?.position[0], {
      message: 'the nudge reaches the server',
    })
    .toBeGreaterThan(placed?.[0]?.position[0] ?? Number.POSITIVE_INFINITY);
  const moved = (await savedTanks(page))[0]?.decorLayout;
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toBeHidden();

  await openTank(page);
  const reopened = await startDecorating(page);
  await expect(reopened.locator('.decor-pieces').getByRole('button', { name: label })).toHaveCount(
    1,
  );
  expect((await savedTanks(page))[0]?.decorLayout).toEqual(moved);
});
