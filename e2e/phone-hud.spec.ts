import { expect, test, type Locator, type Page } from '@playwright/test';
import { openTank, registerVerifiedUser } from './support/app.ts';

const WIDTHS = [360, 390, 430] as const;
const MIN_CARD_PX = 9 * 16;

interface Box {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

async function hudBoxes(page: Page): Promise<Box[]> {
  const parts: [string, Locator][] = [
    ['status card', page.locator('#ui .status-card')],
    ['chemistry chip', page.locator('#ui .chem-chip')],
    ['camera controls', page.locator('#ui .camera-controls')],
    ['tank type', page.locator('#ui .tank-type')],
  ];
  const buttons = page.locator('#ui .hud-buttons > :not(.sr-only)');
  for (let i = 0; i < (await buttons.count()); i++) parts.push([`hud button ${i}`, buttons.nth(i)]);
  const boxes: Box[] = [];
  for (const [name, locator] of parts) {
    if ((await locator.count()) === 0 || !(await locator.first().isVisible())) continue;
    const box = await locator.first().boundingBox();
    if (box) boxes.push({ name, ...box });
  }
  return boxes;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width - 0.5 &&
    b.x < a.x + a.width - 0.5 &&
    a.y < b.y + b.height - 0.5 &&
    b.y < a.y + a.height - 0.5
  );
}

async function expectTidyHud(page: Page, width: number, label: string): Promise<void> {
  const boxes = await hudBoxes(page);
  expect(
    boxes.map((b) => b.name),
    label,
  ).toContain('status card');
  for (const box of boxes) {
    expect(box.x, `${label}: ${box.name} left edge`).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width, `${label}: ${box.name} right edge`).toBeLessThanOrEqual(width + 0.5);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a && b) expect(overlaps(a, b), `${label}: ${a.name} overlaps ${b.name}`).toBe(false);
    }
  }
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  expect(bottom, `${label}: HUD bottom stays inside the stage reserve`).toBeLessThanOrEqual(
    18 * 16,
  );
  const card = boxes.find((b) => b.name === 'status card');
  expect(card?.width ?? 0, `${label}: status card width`).toBeGreaterThanOrEqual(MIN_CARD_PX);
}

test.describe('phone HUD', () => {
  test.use({ hasTouch: true });

  for (const width of WIDTHS) {
    test(`signed out at ${width} px keeps the HUD apart and on screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await openTank(page);
      await expectTidyHud(page, width, `signed out ${width}`);
    });

    test(`signed in at ${width} px keeps the HUD apart and on screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await registerVerifiedUser(page, `phonehud${width}`);
      await openTank(page);
      await expect(page.getByRole('button', { name: /Open the shop/ })).toBeVisible();
      await expectTidyHud(page, width, `signed in ${width}`);
    });
  }
});
