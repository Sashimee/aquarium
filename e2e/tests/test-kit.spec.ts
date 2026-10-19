import { expect, test, type Page } from '@playwright/test';
import { createFirstTank, openDock, openTank, registerVerifiedUser } from '../support/app.ts';

const SHOTS = process.env['E2E_SHOT_DIR'];

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function newTankWithKit(page: Page, label: string) {
  await registerVerifiedUser(page, label);
  await openTank(page);
  await createFirstTank(page);
  await openDock(page, 'Care', 'Care');
  return page.getByRole('region', { name: 'Water test kit' });
}

test('dip a strip, match the pads to the chart and read the chemistry table', async ({ page }) => {
  const kit = await newTankWithKit(page, 'testkit');
  await expect(kit.getByRole('table')).toHaveCount(0);

  await kit.getByRole('button', { name: 'Dip a test strip' }).click();
  await expect(kit.getByRole('group')).toHaveCount(5);

  const table = kit.getByRole('table', { name: 'Chemistry readings' });
  await expect(table.locator('[data-reading="ph"]')).toContainText('Not read yet');

  const ph = kit.getByRole('group', { name: 'pH' });
  await ph.getByRole('radio', { name: '7.0' }).check();
  await expect(ph.getByRole('status')).toContainText('Spot on: 7.0');
  await expect(table.locator('[data-reading="ph"]')).toContainText('7.0');

  const ammonia = kit.getByRole('group', { name: 'Ammonia' });
  await ammonia.getByRole('radio', { name: '1.00 ppm' }).check();
  await expect(ammonia.getByRole('status')).toContainText('Not quite: 0.00 ppm');

  await ph.scrollIntoViewIfNeeded();
  await shot(page, 'test-kit-desktop');

  await kit.getByRole('button', { name: 'Show all readings' }).click();
  await expect(table.locator('[data-reading="nitrate"]')).toContainText('0 ppm');
  await expect(table.locator('[data-reading="nitrate"]')).toContainText('Safe');
  await expect(table.locator('[data-reading="kh"]')).toContainText('3 dKH');
  await expect(table.locator('[data-reading="temperature"]')).toContainText('25.0');
});

test('the kit works by keyboard on a phone-sized screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  const kit = await newTankWithKit(page, 'testkitphone');

  const dip = kit.getByRole('button', { name: 'Dip a test strip' });
  await dip.focus();
  await page.keyboard.press('Enter');
  const ph = kit.getByRole('group', { name: 'pH' });
  await expect(ph).toBeVisible();

  await ph.getByRole('radio').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(ph.getByRole('status')).toBeVisible();

  const table = kit.getByRole('table', { name: 'Chemistry readings' });
  await kit.getByRole('button', { name: 'Show all readings' }).click();
  await expect(table.locator('[data-reading="ammonia"]')).toContainText('Safe');
  const box = await table.boundingBox();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  await table.scrollIntoViewIfNeeded();
  await shot(page, 'test-kit-phone');
});
