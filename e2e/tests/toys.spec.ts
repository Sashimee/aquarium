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

async function canvasPoint(page: Page, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas#tank').boundingBox();
  if (!box) throw new Error('the tank canvas has no box');
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

async function tapCanvas(page: Page, fx: number, fy: number): Promise<void> {
  const at = await canvasPoint(page, fx, fy);
  await page.mouse.click(at.x, at.y);
}

async function ballAt(page: Page): Promise<{ x: number; z: number } | null> {
  const raw = await page.locator('canvas#tank').getAttribute('data-ball');
  if (raw === null) return null;
  const [x, z] = raw.split(' ').map(Number);
  return { x: x ?? NaN, z: z ?? NaN };
}

/**
 * The drag runs inside the page: a flick is read from the time between pointer events, and a
 * software-rendered frame can stretch a driver-side drag from milliseconds to seconds.
 */
async function flickAcross(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.evaluate(
    ({ from, to }) => {
      const canvas = document.querySelector('canvas#tank');
      if (!canvas) throw new Error('the tank canvas is missing');
      const fire = (type: string, x: number, y: number): void => {
        canvas.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 41,
            pointerType: 'mouse',
            isPrimary: true,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
            clientX: x,
            clientY: y,
            bubbles: true,
          }),
        );
      };
      const steps = 6;
      fire('pointerdown', from.x, from.y);
      for (let i = 1; i <= steps; i++) {
        const until = performance.now() + 4;
        while (performance.now() < until);
        fire(
          'pointermove',
          from.x + ((to.x - from.x) * i) / steps,
          from.y + ((to.y - from.y) * i) / steps,
        );
      }
      fire('pointerup', to.x, to.y);
    },
    { from, to },
  );
}

/** A tap on the canvas closes the open sheet, so the panel is reopened to read the toys. */
const openPlay = (page: Page) => openDock(page, 'Play', 'Play with the fish');

const MAX_TOASTS = 10;

async function dismissToasts(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', { name: 'Dismiss message' });
  for (let i = 0; i < MAX_TOASTS && (await dismiss.count()) > 0; i++) {
    await dismiss.first().click();
  }
  await expect(dismiss).toHaveCount(0);
}

const LEFT_TANK: readonly [number, number] = [0.15, 0.5];
const RIGHT_TANK: readonly [number, number] = [0.3, 0.5];

test('the mirror, the ping-pong ball and the shy-fish feeding game work from the play panel', async ({
  page,
}) => {
  test.slow();
  await registerVerifiedUser(page, 'toys');
  await openTank(page, { e2e: true });
  await createFirstTank(page);
  await expect.poll(async () => (await savedTanks(page)).length).toBe(1);
  expect((await savedTanks(page))[0]?.water.uneatenFood).toBe(0);

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

  await expect.poll(() => ballAt(page), { message: 'the ball is in the water' }).not.toBeNull();
  const before = await ballAt(page);
  const start = await canvasPoint(page, ...LEFT_TANK);
  const end = await canvasPoint(page, ...RIGHT_TANK);
  await flickAcross(page, start, end);
  await expect
    .poll(async () => ((await ballAt(page))?.x ?? NaN) - (before?.x ?? 0), {
      message: 'the ball follows the finger',
    })
    .toBeGreaterThan(0.02);
  const released = await ballAt(page);
  await expect
    .poll(async () => ((await ballAt(page))?.x ?? NaN) - (released?.x ?? 0), {
      message: 'the flick carries the ball on after the release',
    })
    .toBeGreaterThan(0.05);

  await openPlay(page);
  await play.getByRole('button', { name: 'Remove ball' }).click();
  await expect(play.getByRole('button', { name: 'Remove ball' })).toHaveCount(0);
  await expect.poll(() => ballAt(page)).toBeNull();

  await play.getByRole('button', { name: 'Mirror' }).click();
  await tapCanvas(page, ...LEFT_TANK);
  await openPlay(page);
  await expect(play.getByRole('button', { name: 'Remove mirror' })).toBeVisible();
  await play.getByRole('button', { name: 'Remove mirror' }).click();
  await expect(play.getByRole('button', { name: 'Remove mirror' })).toHaveCount(0);

  await dismissToasts(page);
  await play.getByRole('button', { name: 'Start round' }).click();
  await expect(play.getByText(/at least two fish/)).toBeVisible();

  await buyFish(page, 'Guppy', 'Glint');
  await buyFish(page, 'Betta', 'Bolt');
  await openPlay(page);

  await dismissToasts(page);
  await play.getByRole('button', { name: 'Start round' }).click();
  const round = play.getByRole('status').filter({ hasText: /^Feed Glint\./ });
  await expect(round).toBeVisible();
  await expect(play.getByRole('button', { name: 'Stop round' })).toBeVisible();
  await expect(play.getByRole('button', { name: 'Tap glass' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await expect(async () => {
    await tapCanvas(page, ...LEFT_TANK);
    await openPlay(page);
    await expect(round).not.toContainText('5 pinches', { timeout: 500 });
  }).toPass({ timeout: 15_000 });
  await expect
    .poll(async () => (await savedTanks(page))[0]?.water.uneatenFood, {
      message: 'the server counts the pinch as a feed',
    })
    .toBeGreaterThan(0);

  await dismissToasts(page);
  await play.getByRole('button', { name: 'Stop round' }).click();
  await expect(play.getByRole('button', { name: 'Start round' })).toBeVisible();
  await expect(play.getByRole('button', { name: 'Mirror' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
