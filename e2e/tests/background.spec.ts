import { expect, test, type Page } from '@playwright/test';
import {
  APP_URL,
  awaitLoaded,
  createFirstTank,
  dockButton,
  openTank,
  registerVerifiedUser,
  savedTanks,
} from '../support/app.ts';

const shownBackground = (page: Page) => page.locator('#app').getAttribute('data-background-id');
const savedBackground = async (page: Page) => (await savedTanks(page))[0]?.backgroundId;

async function startDecorating(page: Page) {
  const panel = page.getByRole('region', { name: 'Decorate the tank' });
  await dockButton(page, 'Decorate').click();
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

test('a background is picked in decorate mode, previewed, saved and kept after a reload', async ({
  page,
}) => {
  test.setTimeout(420_000);
  await registerVerifiedUser(page, 'background');
  await openTank(page);
  await createFirstTank(page);
  expect(await savedBackground(page)).toBe('bg-fw-planted-stream');

  // Only a tank type's default background is free; saving any other one needs its licence.
  const tankId = (await savedTanks(page))[0]?.id;
  for (const id of ['bg-fw-root-tangle', 'bg-fw-misty-lake']) {
    const licence = await page.request.post('/api/shop/purchase', {
      headers: { origin: APP_URL },
      data: { idempotencyKey: crypto.randomUUID(), itemRef: `background:${id}`, tankId },
    });
    expect(licence.status(), await licence.text()).toBe(200);
  }

  const panel = await startDecorating(page);
  const chooser = panel.getByRole('group', { name: 'Background' });
  await expect(chooser.getByRole('button')).toHaveCount(5);
  await expect(chooser.getByRole('button', { name: 'Planted stream' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const pick = chooser.getByRole('button', { name: 'Root tangle' });
  const box = await pick.boundingBox();
  expect(box?.height ?? 0, 'a touch-sized target').toBeGreaterThanOrEqual(40);
  await pick.click();
  await expect(pick).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => shownBackground(page)).toBe('bg-fw-root-tangle');
  await expect.poll(() => savedBackground(page)).toBe('bg-fw-root-tangle');

  const keyboardPick = chooser.getByRole('button', { name: 'Misty planted tank' });
  await keyboardPick.focus();
  await page.keyboard.press('Enter');
  await expect(keyboardPick).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => shownBackground(page)).toBe('bg-fw-misty-lake');
  await expect.poll(() => savedBackground(page)).toBe('bg-fw-misty-lake');

  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toBeHidden();

  await page.goto('/?tier=low&backend=webgl');
  await awaitLoaded(page);
  await expect.poll(() => shownBackground(page)).toBe('bg-fw-misty-lake');
  const reopened = await startDecorating(page);
  await expect(
    reopened
      .getByRole('group', { name: 'Background' })
      .getByRole('button', { name: 'Misty planted tank' }),
  ).toHaveAttribute('aria-pressed', 'true');
});
