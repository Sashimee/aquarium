import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { registerVerifiedUser } from './support/app';

let pageErrors: string[] = [];

// The fish system starts a few seconds after load, and under software rendering one read can block
// the page for 20 s or more.
const FISH_START_MS = 60_000;

const SPECIES_DIR = resolve(import.meta.dirname, '../content/species');

function speciesOf(biome: 'freshwater' | 'reef'): string[] {
  return readdirSync(SPECIES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map(
      (file) =>
        JSON.parse(readFileSync(resolve(SPECIES_DIR, file), 'utf8')) as Record<string, string>,
    )
    .filter((species) => species['biome'] === biome)
    .map((species) => species['id'] ?? '');
}

const swimming = async (page: Page): Promise<string[]> => {
  const value = await page.locator('canvas#tank').getAttribute('data-fish-species');
  return value === null || value === '' ? [] : value.split(',');
};

async function expectOnly(
  page: Page,
  biome: 'freshwater' | 'reef',
  timeout?: number,
): Promise<void> {
  const allowed = speciesOf(biome);
  expect(allowed.length, `content/species has ${biome} species`).toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        const fish = await swimming(page);
        return fish.length > 0 && fish.every((id) => allowed.includes(id));
      },
      { message: `the swimming fish are all ${biome} species`, ...(timeout ? { timeout } : {}) },
    )
    .toBe(true);
}

function collectPageErrors(page: Page): void {
  page.on('pageerror', (error) => pageErrors.push(error.message));
}

async function open(page: Page, url: string): Promise<void> {
  collectPageErrors(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('canvas#tank')).toBeVisible();
  await page.getByRole('button', { name: 'Tank report' }).click();
  await expect(page.getByText(/Rendering with WebGL 2 at the low quality tier/)).toBeVisible();
}

const typeButton = (page: Page, name: 'Freshwater' | 'Reef') =>
  page.getByRole('group', { name: 'Tank type' }).getByRole('button', { name, exact: true });

const sceneBiome = (page: Page) => page.locator('#app');

const biomeParam = (page: Page) => new URL(page.url()).searchParams.get('biome');

test.describe('tank type switch', () => {
  test.beforeEach(() => {
    pageErrors = [];
  });

  test.afterEach(() => {
    expect(pageErrors, 'the page raised errors').toEqual([]);
  });

  test('an anonymous visitor switches the demo tank and the URL follows', async ({ page }) => {
    await open(page, '/?backend=webgl&tier=low&e2e');
    await expect(typeButton(page, 'Freshwater')).toHaveAttribute('aria-pressed', 'true');
    await expectOnly(page, 'freshwater', FISH_START_MS);
    await expect(page.getByText(/300 litre freshwater aquarium/)).toBeVisible();

    await typeButton(page, 'Reef').click();
    await expect(typeButton(page, 'Reef')).toHaveAttribute('aria-pressed', 'true');
    await expect(typeButton(page, 'Freshwater')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText(/300 litre reef aquarium/)).toBeVisible();
    await expect(sceneBiome(page)).toHaveAttribute('data-scene-biome', 'reef');
    await expectOnly(page, 'reef', FISH_START_MS);
    await expect.poll(() => biomeParam(page)).toBe('reef');
    expect(new URL(page.url()).searchParams.get('backend')).toBe('webgl');

    await typeButton(page, 'Freshwater').click();
    await expect(page.getByText(/300 litre freshwater aquarium/)).toBeVisible();
    await expect(sceneBiome(page)).toHaveAttribute('data-scene-biome', 'freshwater');
    await expectOnly(page, 'freshwater', FISH_START_MS);
    await expect.poll(() => biomeParam(page)).toBe('freshwater');
  });

  test('a reef link opens on the reef', async ({ page }) => {
    await open(page, '/?backend=webgl&tier=low&biome=reef&e2e');
    await expect(typeButton(page, 'Reef')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/300 litre reef aquarium/)).toBeVisible();
    await expect(sceneBiome(page)).toHaveAttribute('data-scene-biome', 'reef');
    await expectOnly(page, 'reef', FISH_START_MS);
  });

  test('works by tap at phone width without overflowing', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await open(page, '/?backend=webgl&tier=low');
    const reef = typeButton(page, 'Reef');
    await expect(reef).toBeInViewport();
    const box = await reef.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(40);
    await reef.tap();
    await expect(reef).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => biomeParam(page)).toBe('reef');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await context.close();
  });

  test('a signed-in player is led to create the tank type they do not have', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      HTMLCanvasElement.prototype.getContext = () => null;
    });
    const page = await context.newPage();
    await registerVerifiedUser(page, 'switch');
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await typeButton(page, 'Reef').click();
    await expect(page.getByLabel('Kind of tank')).toHaveValue('reef');
    await page.getByRole('button', { name: 'Create tank' }).click();
    await expect(typeButton(page, 'Reef')).toHaveAttribute('aria-pressed', 'true');

    await typeButton(page, 'Freshwater').click();
    await expect(page.getByLabel('Kind of tank')).toHaveValue('freshwater');
    await page.getByRole('button', { name: 'Create tank' }).click();
    await expect(typeButton(page, 'Freshwater')).toHaveAttribute('aria-pressed', 'true');

    await typeButton(page, 'Reef').click();
    await expect(typeButton(page, 'Reef')).toHaveAttribute('aria-pressed', 'true');
    await context.close();
  });
});
