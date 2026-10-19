import { expect, test, type Locator, type Page } from '@playwright/test';
import { dockButton, openTank } from '../support/app.ts';

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
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
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

async function takePhoto(page: Page): Promise<Pixels> {
  await page.getByRole('button', { name: 'Take photo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Your photo' });
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await expect(dialog.locator('img.photo-preview')).toBeVisible();
  const pixels = await measurePreview(page);
  await dialog.getByRole('button', { name: 'Keep shooting' }).click();
  await expect(dialog).toHaveCount(0);
  return pixels;
}

async function enterPhotoMode(page: Page): Promise<Locator> {
  await openTank(page);
  const tools = page.getByRole('region', { name: 'Photo controls' });
  await dockButton(page, 'Photo').click();
  await expect(tools).toBeVisible();
  return tools;
}

test('photo mode: enter, capture a real picture, hide controls, exit', async ({ page }) => {
  const tools = await enterPhotoMode(page);
  await expect(page.locator('.shell')).toHaveClass(/photo-on/);
  await expect(dockButton(page, 'Feed')).toBeHidden();

  const natural = await takePhoto(page);
  expect(natural.width).toBeGreaterThan(800);
  expect(natural.height).toBeGreaterThan(500);
  expect(natural.spread, 'the picture has detail, not a flat colour').toBeGreaterThan(5);

  await page.getByRole('button', { name: 'Hide controls' }).click();
  await expect(tools).toBeHidden();
  await page.getByRole('button', { name: 'Show controls' }).click();
  await expect(tools).toBeVisible();

  await page.getByRole('button', { name: 'Exit' }).click();
  await expect(tools).toHaveCount(0);
  await expect(page.locator('.shell')).not.toHaveClass(/photo-on/);
  await expect(dockButton(page, 'Feed')).toBeVisible();
});

test('photo mode: the black and white filter captures a picture without colour', async ({
  page,
}) => {
  const tools = await enterPhotoMode(page);
  await tools.getByRole('radio', { name: 'Black and white' }).check();
  await expect(tools.getByRole('radio', { name: 'Black and white' })).toBeChecked();
  const bw = await takePhoto(page);
  expect(bw.spread).toBeGreaterThan(5);
  expect(bw.tint, 'black and white has no colour').toBeLessThan(5);
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
