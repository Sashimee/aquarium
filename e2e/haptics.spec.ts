import { expect, test, type Page } from '@playwright/test';
import { openAccount, openDock, openTank, registerVerifiedUser } from './support/app.ts';

declare global {
  interface Window {
    __buzzes: (number | number[])[];
  }
}

const buzzes = (page: Page) => page.evaluate(() => window.__buzzes.slice());

async function recordVibration(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__buzzes = [];
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (pattern: number | number[]) => {
        window.__buzzes.push(pattern);
        return true;
      },
    });
  });
}

async function tapGlass(page: Page, at = 0.5): Promise<void> {
  const box = await page.locator('#tank').boundingBox();
  if (!box) throw new Error('the tank canvas has no box');
  await page.mouse.click(box.x + box.width * at, box.y + box.height * at);
}

test.describe('haptics', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('buzz on glass tap and food drop, and stop once switched off', async ({ page }) => {
    await recordVibration(page);
    await registerVerifiedUser(page, 'haptics');
    await openTank(page);

    await tapGlass(page);
    await expect.poll(() => buzzes(page)).toHaveLength(1);

    await openDock(page, 'Feed', 'Feed the fish');
    await page.getByRole('button', { name: 'Drop food' }).click();
    await expect.poll(() => buzzes(page)).toContainEqual([10, 40, 10]);

    const menu = await openAccount(page);
    await menu.getByRole('link', { name: 'Settings' }).click();
    const toggle = page.getByRole('checkbox', { name: 'Haptic feedback' });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();

    await page.getByRole('link', { name: 'Back to the tank' }).click();
    await expect(page.locator('#tank')).toBeVisible();
    const before = (await buzzes(page)).length;
    await tapGlass(page);
    expect(await buzzes(page)).toHaveLength(before);
  });

  test('stay silent under reduced motion and resume when it ends', async ({ page }) => {
    await recordVibration(page);
    await registerVerifiedUser(page, 'haptics-motion');
    await openTank(page);
    await tapGlass(page, 0.48);
    await expect.poll(() => buzzes(page)).toHaveLength(1);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await tapGlass(page, 0.5);
    expect(await buzzes(page)).toHaveLength(1);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await tapGlass(page, 0.52);
    await expect.poll(() => buzzes(page)).toHaveLength(2);
  });

  test('disable the switch where the browser has no vibration (iOS Safari)', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'vibrate', { value: undefined });
      Object.defineProperty(navigator, 'vibrate', { value: undefined });
    });
    await registerVerifiedUser(page, 'haptics-ios');
    await page.goto('/settings');
    await expect(page.getByRole('checkbox', { name: 'Haptic feedback' })).toBeDisabled();
    await expect(page.getByText(/does not support vibration/)).toBeVisible();
  });
});
