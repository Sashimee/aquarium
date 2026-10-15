import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  APP_URL,
  createFirstTank,
  dockButton,
  openTank,
  registerVerifiedUser,
  savedTanks,
} from '../support/app.ts';

type Layout = Awaited<ReturnType<typeof savedTanks>>[number]['decorLayout'] | undefined;

// Pieces settle onto the substrate when a tank loads, which nudges heights by a fraction of a millimetre.
function roughly(layout: Layout) {
  return layout?.map((piece) => ({
    ...piece,
    position: piece.position.map((n) => Math.round(n * 100) / 100),
  }));
}

async function startDecorating(page: Page) {
  const panel = page.getByRole('region', { name: 'Decorate the tank' });
  await dockButton(page, 'Decorate').click();
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

// Each cold boot costs 25-45 s under software rendering, so the three tests share one page, one
// account and one tank, and run in order.
test.describe.configure({ mode: 'serial' });
let context: BrowserContext | undefined;
let shared: Page | undefined;

test.beforeAll(async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error('playwright.config.ts must set use.baseURL');
  context = await browser.newContext({ baseURL });
  shared = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

function sharedPage(): Page {
  if (!shared) throw new Error('the shared page did not start; see the beforeAll failure');
  return shared;
}

test('Decorate pressed before the tank is ready still opens the editor', async () => {
  const page = sharedPage();
  test.setTimeout(120_000);
  await page.goto('/?tier=low&backend=webgl', { waitUntil: 'domcontentloaded' });
  const toggle = dockButton(page, 'Decorate');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('region', { name: 'Decorate the tank' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();
});

test('a decor piece is swapped, moved, saved and still there after a reload', async () => {
  const page = sharedPage();
  test.setTimeout(420_000);
  await registerVerifiedUser(page, 'decor');
  await openTank(page);
  await createFirstTank(page);
  expect((await savedTanks(page))[0]?.decorLayout).toEqual([]);
  expect((await savedTanks(page))[0]?.decorEdited).toBe(false);

  const panel = await startDecorating(page);
  const inTank = panel.locator('.decor-pieces');
  await expect(inTank.getByRole('button').first()).toBeVisible({ timeout: 60_000 });
  const startCount = await inTank.getByRole('button').count();

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

  // The new piece lands in the nearest free spot, so which neighbour blocks a nudge (a plant stem
  // inside a rock is refused) depends on the layout; step towards the first open side.
  const layoutJson = async () => JSON.stringify((await savedTanks(page))[0]?.decorLayout);
  for (const side of ['Right', 'Left', 'Back', 'Forward']) {
    await panel.getByRole('button', { name: side, exact: true }).click();
    const reached = await expect
      .poll(layoutJson, { timeout: 4_000 })
      .not.toBe(JSON.stringify(placed))
      .then(
        () => true,
        () => false,
      );
    if (reached) break;
  }
  await expect
    .poll(layoutJson, { message: 'the nudge reaches the server' })
    .not.toBe(JSON.stringify(placed));
  const moved = (await savedTanks(page))[0]?.decorLayout;
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toBeHidden();

  await openTank(page);
  const reopened = await startDecorating(page);
  await expect(reopened.locator('.decor-pieces').getByRole('button')).toHaveCount(startCount);
  expect(roughly((await savedTanks(page))[0]?.decorLayout)).toEqual(roughly(moved));
  await reopened.getByRole('button', { name: 'Done' }).click();
  await expect(reopened).toBeHidden();
});

test('the palette follows the tank biome and the server refuses what it hides', async () => {
  const page = sharedPage();
  test.setTimeout(420_000);
  const tank = (await savedTanks(page))[0];
  if (!tank) throw new Error('the first tank was not saved');

  const panel = await startDecorating(page);
  await expect(panel.getByRole('button', { name: 'Add Driftwood branch' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Add Reef arch' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Add Vacation feeder' })).toBeEnabled();

  await panel.getByRole('button', { name: 'Add Vacation feeder' }).click();
  await expect(panel.getByRole('button', { name: 'Add Vacation feeder' })).toBeDisabled();
  await expect(panel.getByText('already has its one vacation feeder')).toBeVisible();
  await expect
    .poll(async () =>
      (await savedTanks(page))[0]?.decorLayout.some((p) => p.assetId === 'vacation-feeder'),
    )
    .toBe(true);

  const rejected = await page.request.patch(`/api/tanks/${tank.id}`, {
    headers: { origin: APP_URL },
    data: {
      decorLayout: [{ assetId: 'reef-arch', position: [0, 0.05, 0], rotationY: 0, scale: 1 }],
    },
  });
  expect(rejected.status()).toBe(400);
  expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe(
    'validation_failed',
  );
});
