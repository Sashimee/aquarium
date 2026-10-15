import { expect, test, type Page } from '@playwright/test';
import { dockButton, openTank } from './support/app';

test.use({ reducedMotion: 'no-preference' });

const pose = (page: Page) => page.locator('canvas#tank').getAttribute('data-camera');

async function posesOverFrames(page: Page, count: number): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < count; i += 1) {
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
    seen.push((await pose(page)) ?? '');
  }
  return seen;
}

test.describe('default motion', () => {
  const errors: string[] = [];

  test.beforeEach(async ({ page }) => {
    errors.length = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    await openTank(page);
  });

  test.afterEach(() => {
    expect(errors, 'the page raised errors').toEqual([]);
  });

  test('the camera eases to a followed fish and back outside', async ({ page }) => {
    const camera = page.getByRole('group', { name: 'Camera' });
    const follow = camera.getByRole('button', { name: 'Follow', exact: true });
    const outside = camera.getByRole('button', { name: 'Outside', exact: true });
    const before = await pose(page);
    await follow.click();
    await expect(follow).toHaveAttribute('aria-pressed', 'true');
    const travel = await posesOverFrames(page, 6);
    expect(new Set(travel).size, 'the pose moved in several steps, not one jump').toBeGreaterThan(
      2,
    );
    expect(travel.at(-1)).not.toBe(before);

    await outside.click();
    await expect(outside).toHaveAttribute('aria-pressed', 'true');
  });

  test('a decor piece is added and settles without errors', async ({ page }) => {
    await dockButton(page, 'Decorate').click();
    const panel = page.getByRole('region', { name: 'Decorate the tank' });
    await expect(panel).toBeVisible({ timeout: 60_000 });
    const pieces = panel.locator('.decor-pieces').getByRole('button');
    await expect(pieces.first()).toBeVisible({ timeout: 60_000 });
    const start = await pieces.count();
    await panel
      .getByRole('button', { name: /^Add (?!Vacation feeder)/ })
      .first()
      .click();
    await expect(pieces).toHaveCount(start + 1);
    await posesOverFrames(page, 30);
  });
});
