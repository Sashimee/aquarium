import { expect, test, type Page } from '@playwright/test';
import {
  createFirstTank,
  openDock,
  openTank,
  registerVerifiedUser,
  savedTanks,
} from '../support/app.ts';

async function buyFish(page: Page, commonName: string, fishName: string): Promise<void> {
  const shop = await openDock(page, 'Shop', 'Fish shop');
  await page.getByLabel('Name for the new fish').fill(fishName);
  await shop
    .getByRole('listitem')
    .filter({ hasText: commonName })
    .getByRole('button', { name: 'Add', exact: true })
    .click();
  await expect(page.locator('.life-status')).toContainText(`${fishName} is in a bag`);
  await page.getByRole('button', { name: `Release ${fishName} now` }).click();
}

async function tapCanvas(page: Page, fx: number, fy: number): Promise<void> {
  const box = await page.locator('canvas#tank').boundingBox();
  if (!box) throw new Error('the tank canvas has no box');
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

/** The play sheet covers the right half on a small screen, so the taps stay on the left. */
/** A tap on the canvas closes the open sheet, so the panel is reopened to read the toys. */
const openPlay = (page: Page) => openDock(page, 'Play', 'Play with the fish');

async function dismissToasts(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', { name: 'Dismiss message' });
  while ((await dismiss.count()) > 0) await dismiss.first().click();
}

const LEFT_TANK: readonly [number, number] = [0.15, 0.5];

test('the mirror, the ping-pong ball and the shy-fish feeding game work from the play panel', async ({
  page,
}) => {
  await registerVerifiedUser(page, 'toys');
  await openTank(page);
  await createFirstTank(page);
  await expect.poll(async () => (await savedTanks(page)).length).toBe(1);

  const play = await openPlay(page);
  await expect(play.getByRole('button', { name: 'Remove ball' })).toHaveCount(0);

  await play.getByRole('button', { name: 'Ping-pong ball' }).click();
  await expect(play.getByRole('button', { name: 'Ping-pong ball' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await tapCanvas(page, ...LEFT_TANK);
  await openPlay(page);
  await expect(play.getByRole('button', { name: 'Remove ball' })).toBeVisible();
  await play.getByRole('button', { name: 'Remove ball' }).click();
  await expect(play.getByRole('button', { name: 'Remove ball' })).toHaveCount(0);

  await play.getByRole('button', { name: 'Mirror' }).click();
  await tapCanvas(page, ...LEFT_TANK);
  await openPlay(page);
  await expect(play.getByRole('button', { name: 'Remove mirror' })).toBeVisible();
  await play.getByRole('button', { name: 'Remove mirror' }).click();
  await expect(play.getByRole('button', { name: 'Remove mirror' })).toHaveCount(0);

  await dismissToasts(page);
  await play.getByRole('button', { name: 'Start round' }).click();
  await expect(play.getByText(/at least two fish/)).toBeVisible();

  await buyFish(page, 'Neon tetra', 'Glint');
  await buyFish(page, 'Guppy', 'Bolt');
  await openPlay(page);

  await dismissToasts(page);
  await play.getByRole('button', { name: 'Start round' }).click();
  await expect(play.getByRole('status').filter({ hasText: /^Feed \w+\./ })).toBeVisible();
  await expect(play.getByRole('button', { name: 'Stop round' })).toBeVisible();

  const round = play.getByRole('status').filter({ hasText: /^Feed/ });
  await expect(async () => {
    await tapCanvas(page, ...LEFT_TANK);
    await openPlay(page);
    await expect(round).not.toContainText('5 pinches', { timeout: 500 });
  }).toPass({ timeout: 15_000 });

  await dismissToasts(page);
  await play.getByRole('button', { name: 'Stop round' }).click();
  await expect(play.getByRole('button', { name: 'Start round' })).toBeVisible();
});
