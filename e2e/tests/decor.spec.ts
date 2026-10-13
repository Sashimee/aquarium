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

test('a decor piece is swapped, moved, saved and still there after a reload', async ({ page }) => {
  await registerVerifiedUser(page, 'decor');
  await openTank(page);
  await createFirstTank(page);
  expect((await savedTanks(page))[0]?.decorLayout).toEqual([]);

  const panel = await startDecorating(page);
  const inTank = panel.locator('.decor-pieces');
  const startCount = await inTank.getByRole('button').count();
  expect(startCount).toBeGreaterThan(0);

  await inTank.getByRole('button').first().click();
  await panel.getByRole('button', { name: 'Remove' }).click();
  await expect(inTank.getByRole('button')).toHaveCount(startCount - 1);

  await panel
    .getByRole('button', { name: /^Add (?!Vacation feeder)/ })
    .first()
    .click();
  await expect(inTank.getByRole('button')).toHaveCount(startCount);
  await expect(panel.getByText('Layout saved.')).toBeVisible();
  const placed = (await savedTanks(page))[0]?.decorLayout;
  expect(placed?.length).toBeGreaterThanOrEqual(startCount);

  await panel.getByRole('button', { name: 'Right', exact: true }).click();
  await expect
    .poll(async () => JSON.stringify((await savedTanks(page))[0]?.decorLayout), {
      message: 'the nudge reaches the server',
    })
    .not.toBe(JSON.stringify(placed));
  const moved = (await savedTanks(page))[0]?.decorLayout;
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toBeHidden();

  await openTank(page);
  const reopened = await startDecorating(page);
  await expect(reopened.locator('.decor-pieces').getByRole('button')).toHaveCount(startCount);
  expect((await savedTanks(page))[0]?.decorLayout).toEqual(moved);
});
