import { expect, test, type Page } from '@playwright/test';
import { dockButton, openTank } from '../support/app.ts';

/**
 * SwiftShader draws every pixel on the CPU, and a capture waits for all the frames queued before
 * it. A small canvas keeps each action and each capture quick; at the capture's 2x scale it still
 * yields a picture wider than 800 px.
 */
test.use({ viewport: { width: 480, height: 340 } });

interface Pixels {
  width: number;
  height: number;
  spread: number;
  tint: number;
}

/** Decodes the preview in the page and measures it: a flat or blank picture has no spread. */
async function measurePreview(page: Page): Promise<Pixels> {
  return page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>('img.photo-preview');
    if (!img) throw new Error('the photo preview is missing');
    await img.decode();
    const bitmap = await createImageBitmap(img);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let sum = 0;
    let sumSq = 0;
    let tint = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const luma = (r + g + b) / 3;
      sum += luma;
      sumSq += luma * luma;
      tint += Math.abs(r - g) + Math.abs(g - b);
    }
    const mean = sum / pixels;
    return {
      width: bitmap.width,
      height: bitmap.height,
      spread: Math.sqrt(Math.max(0, sumSq / pixels - mean * mean)),
      tint: tint / pixels,
    };
  });
}

async function fps(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const tick = (): void => {
          n++;
          if (performance.now() - t0 > 3000) resolve(n / 3);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

async function takePhoto(page: Page): Promise<Pixels> {
  const t0 = Date.now();
  console.log(`TIMING fps before capture ${await fps(page)} (${Date.now() - t0} ms)`);
  const t1 = Date.now();
  await page.getByRole('button', { name: 'Take photo' }).click();
  console.log(`TIMING click ${Date.now() - t1} ms`);
  const dialog = page.getByRole('dialog', { name: 'Your photo' });
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  console.log(`TIMING dialog visible ${Date.now() - t1} ms`);
  await expect(dialog.locator('img.photo-preview')).toBeVisible();
  const pixels = await measurePreview(page);
  console.log(`TIMING measured ${Date.now() - t1} ms`);
  await dialog.getByRole('button', { name: 'Keep shooting' }).click();
  await expect(dialog).toHaveCount(0);
  return pixels;
}

test('photo mode: enter, change filter, capture a real picture, hide controls, exit', async ({
  page,
}) => {
  await openTank(page);
  const tools = page.getByRole('region', { name: 'Photo controls' });

  await dockButton(page, 'Photo').click();
  await expect(tools).toBeVisible();
  await expect(page.locator('.shell')).toHaveClass(/photo-on/);
  await expect(dockButton(page, 'Feed')).toBeHidden();

  const natural = await takePhoto(page);
  expect(natural.width).toBeGreaterThan(800);
  expect(natural.height).toBeGreaterThan(500);
  expect(natural.spread, 'the picture has detail, not a flat colour').toBeGreaterThan(5);

  await tools.getByRole('radio', { name: 'Black and white' }).check();
  await expect(tools.getByRole('radio', { name: 'Black and white' })).toBeChecked();
  const bw = await takePhoto(page);
  expect(bw.spread).toBeGreaterThan(5);
  expect(bw.tint, 'black and white has no colour').toBeLessThan(natural.tint / 2);

  await page.getByRole('button', { name: 'Hide controls' }).click();
  await expect(tools).toBeHidden();
  await page.getByRole('button', { name: 'Show controls' }).click();
  await expect(tools).toBeVisible();

  await page.getByRole('button', { name: 'Exit' }).click();
  await expect(tools).toHaveCount(0);
  await expect(page.locator('.shell')).not.toHaveClass(/photo-on/);
  await expect(dockButton(page, 'Feed')).toBeVisible();
});

test('photo mode: the keyboard hides the controls and leaves', async ({ page }) => {
  await openTank(page);
  await dockButton(page, 'Photo').click();
  const tools = page.getByRole('region', { name: 'Photo controls' });
  await expect(tools).toBeVisible();

  await page.keyboard.press('h');
  await expect(tools).toBeHidden();
  await page.keyboard.press('h');
  await expect(tools).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(tools).toHaveCount(0);
});
