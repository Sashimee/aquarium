import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'correct horse battery';

let pageErrors: string[] = [];

function collectPageErrors(page: Page): void {
  page.on('pageerror', (error) => pageErrors.push(error.message));
}

async function open(page: Page, url: string): Promise<void> {
  collectPageErrors(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('canvas#tank')).toBeVisible();
  await page.getByRole('button', { name: 'Tank report' }).click();
}

const typeButton = (page: Page, name: 'Freshwater' | 'Reef') =>
  page.getByRole('group', { name: 'Tank type' }).getByRole('button', { name, exact: true });

const biomeParam = (page: Page) => new URL(page.url()).searchParams.get('biome');

test.describe('tank type switch', () => {
  test.beforeEach(() => {
    pageErrors = [];
  });

  test.afterEach(() => {
    expect(pageErrors, 'the page raised errors').toEqual([]);
  });

  test('an anonymous visitor switches the demo tank and the URL follows', async ({ page }) => {
    await open(page, '/?backend=webgl&tier=low');
    await expect(typeButton(page, 'Freshwater')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/300 litre freshwater aquarium/)).toBeVisible();

    await typeButton(page, 'Reef').click();
    await expect(typeButton(page, 'Reef')).toHaveAttribute('aria-pressed', 'true');
    await expect(typeButton(page, 'Freshwater')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText(/300 litre reef aquarium/)).toBeVisible();
    await expect.poll(() => biomeParam(page)).toBe('reef');
    expect(new URL(page.url()).searchParams.get('backend')).toBe('webgl');

    await typeButton(page, 'Freshwater').click();
    await expect(page.getByText(/300 litre freshwater aquarium/)).toBeVisible();
    await expect.poll(() => biomeParam(page)).toBe('freshwater');
  });

  test('a reef link opens on the reef', async ({ page }) => {
    await open(page, '/?backend=webgl&tier=low&biome=reef');
    await expect(typeButton(page, 'Reef')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/300 litre reef aquarium/)).toBeVisible();
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
    const email = `switch-${Date.now()}@bas.lu`;
    await page.goto('/sign-up', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Your name', { exact: true }).fill('Switch Tester');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    let link = '';
    await expect
      .poll(async () => {
        const res = await page.request.get('/__e2e/outbox');
        const mails = (await res.json()) as { to: string; subject: string; text: string }[];
        const mail = mails.find((m) => m.to === email && /verify/i.test(m.subject));
        link = /<(https?:\/\/[^>]+)>/.exec(mail?.text ?? '')?.[1] ?? '';
        return link;
      })
      .not.toBe('');
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
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
