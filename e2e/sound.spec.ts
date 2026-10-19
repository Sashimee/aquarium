import { expect, test } from '@playwright/test';
import { openAccount, openTank, registerVerifiedUser } from './support/app.ts';

const soundButton = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: 'Sound', exact: true });

async function openSettings(page: import('@playwright/test').Page): Promise<void> {
  const menu = await openAccount(page);
  await menu.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Sound' })).toBeVisible();
}

test.describe('sound', () => {
  test('stay off until the first gesture, then fetch sounds by role', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('.m4a')) requested.push(request.url());
    });
    await registerVerifiedUser(page, 'sound-unlock');
    await openTank(page);
    expect(requested).toEqual([]);

    await page.locator('#tank').click();
    await expect.poll(() => requested.some((url) => url.includes('/audio/glass-tap/'))).toBe(true);
    expect(requested.some((url) => url.includes('/audio/underwater-bed/'))).toBe(true);
  });

  test('mute toggle and settings persist across a reload', async ({ page }) => {
    await registerVerifiedUser(page, 'sound-persist');
    await openTank(page);
    await expect(soundButton(page)).toHaveAttribute('aria-pressed', 'true');

    await soundButton(page).click();
    await expect(soundButton(page)).toHaveAttribute('aria-pressed', 'false');

    await openSettings(page);
    const play = page.getByRole('checkbox', { name: 'Play sound' });
    await expect(play).not.toBeChecked();
    await page.getByRole('slider', { name: 'Volume' }).fill('30');
    await page.getByRole('checkbox', { name: 'No sudden loud sounds' }).check();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sound' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Play sound' })).not.toBeChecked();
    await expect(page.getByRole('slider', { name: 'Volume' })).toHaveValue('30');
    await expect(page.getByRole('checkbox', { name: 'No sudden loud sounds' })).toBeChecked();

    await page.getByRole('checkbox', { name: 'Play sound' }).check();
    await page.reload();
    await expect(page.getByRole('checkbox', { name: 'Play sound' })).toBeChecked();
  });
});
