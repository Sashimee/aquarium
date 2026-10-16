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

async function setReducedMotion(page: Page, reduced: boolean): Promise<void> {
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  // The page's media-query listeners run in the update-the-rendering step, so two frames after the
  // query flips the app has observed the change; software rendering can make that take seconds.
  await page.evaluate(
    (expected) =>
      new Promise<void>((resolve) => {
        const query = window.matchMedia('(prefers-reduced-motion: reduce)');
        const settle = () => {
          if (query.matches !== expected) {
            requestAnimationFrame(settle);
            return;
          }
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        };
        settle();
      }),
    reduced,
  );
}

async function setHapticsSwitch(page: Page, on: boolean): Promise<void> {
  const menu = await openAccount(page);
  await menu.getByRole('link', { name: 'Settings' }).click();
  const toggle = page.getByRole('checkbox', { name: 'Haptic feedback' });
  await toggle.setChecked(on);
  await expect(toggle).toBeChecked({ checked: on });
  await page.getByRole('link', { name: 'Back to the tank' }).click();
  await expect(page.locator('#tank')).toBeVisible();
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

    await setHapticsSwitch(page, false);
    const before = (await buzzes(page)).length;
    await tapGlass(page);
    await openDock(page, 'Feed', 'Feed the fish');
    await page.getByRole('button', { name: 'Drop food' }).click();
    expect(await buzzes(page)).toHaveLength(before);

    await setHapticsSwitch(page, true);
    await tapGlass(page);
    await expect.poll(() => buzzes(page)).toHaveLength(before + 1);
  });

  test('stay silent under reduced motion and resume when it ends', async ({ page }) => {
    await recordVibration(page);
    await registerVerifiedUser(page, 'haptics-motion');
    await openTank(page);
    await tapGlass(page);
    await expect.poll(() => buzzes(page)).toHaveLength(1);

    await setReducedMotion(page, true);
    await tapGlass(page);
    expect(await buzzes(page)).toHaveLength(1);

    await setReducedMotion(page, false);
    await tapGlass(page);
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
