import { expect, test, type Page } from '@playwright/test';
import {
  createFirstTank,
  openAccount,
  openDock,
  openTank,
  registerVerifiedUser,
} from './support/app.ts';

const SHOTS = process.env['E2E_SHOTS'];

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const bookDialog = (page: Page) => page.getByRole('dialog', { name: 'Collection book' });

test('the collection book shows kept species, locked silhouettes and achievements', async ({
  page,
}) => {
  await registerVerifiedUser(page, 'book');
  await openTank(page);
  await createFirstTank(page);

  await openDock(page, 'Shop', 'Fish shop');
  await page.getByLabel('Name for the new fish').fill('Pip');
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await expect(page.locator('.life-status')).toContainText('Pip is in a bag');
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  const opener = page.getByRole('button', { name: 'Collection book' });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = bookDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Collection book' })).toBeFocused();

  const found = dialog.locator('[data-state="found"]');
  await expect(found).toHaveCount(1);
  await expect(found.first()).toContainText(/First kept \d{1,2} \w{3} \d{4}/);
  expect(await dialog.locator('[data-state="locked"]').count()).toBeGreaterThan(0);
  await expect(dialog.locator('[data-state="locked"]').first()).toContainText('???');
  await expect(dialog.locator('.book-summary')).toContainText('1 of');
  await shot(page, 'species');

  for (let i = 0; i < 80; i += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(
      () => document.querySelector('[role="dialog"]')?.contains(document.activeElement) ?? false,
    );
    expect(inside, `focus escaped the dialog after ${i + 1} Tab presses`).toBe(true);
  }

  await dialog.getByRole('heading', { name: 'Collection book' }).focus();
  await page.keyboard.press('Shift+Tab');
  const wrapped = await page.evaluate(
    () => document.querySelector('[role="dialog"]')?.contains(document.activeElement) ?? false,
  );
  expect(wrapped, 'Shift+Tab from the heading left the dialog').toBe(true);

  await dialog.getByRole('button', { name: 'Achievements' }).click();
  const first = dialog.locator('[data-achievement="first-fish"]');
  await expect(first).toHaveAttribute('data-earned', 'true');
  await expect(first).toContainText(/Earned \d{1,2} \w{3} \d{4}/);
  const hobbyist = dialog.locator('[data-achievement="kept-5"]');
  await expect(hobbyist).toHaveAttribute('data-earned', 'false');
  await expect(hobbyist).toContainText('1 of 5');
  await shot(page, 'achievements');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await openAccount(page);
  await page
    .getByRole('navigation', { name: 'Account' })
    .getByRole('button', { name: 'Collection book' })
    .click();
  await expect(bookDialog(page)).toBeVisible();
  await bookDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(bookDialog(page)).toBeHidden();
});

test('a failed load says so and can be retried', async ({ page }) => {
  await registerVerifiedUser(page, 'bookerr');
  await openTank(page);
  let failing = true;
  await page.route('**/api/collection', async (route) => {
    if (failing) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal', message: 'The book is stuck.' } }),
      });
      return;
    }
    await route.continue();
  });

  await page.getByRole('button', { name: 'Collection book' }).click();
  const alert = bookDialog(page).getByRole('alert');
  await expect(alert).toContainText('The book is stuck.');
  await shot(page, 'error');

  failing = false;
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(bookDialog(page).locator('.book-summary')).toContainText('0 of');
  await expect(bookDialog(page).locator('[data-state="locked"]').first()).toBeVisible();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the book is reachable from the HUD and fits the screen', async ({ page }) => {
    await registerVerifiedUser(page, 'bookphone');
    await openTank(page);
    await page.getByRole('button', { name: 'Collection book' }).tap();
    const dialog = bookDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.book-summary')).toBeVisible();
    const close = dialog.getByRole('button', { name: 'Close', exact: true });
    await dialog.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(close).toBeInViewport();
    await dialog.evaluate((el) => el.scrollTo(0, 0));
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await shot(page, 'phone');
  });
});
