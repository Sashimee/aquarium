import { expect, test, type Page } from '@playwright/test';

interface SentMail {
  to: string;
  subject: string;
  text: string;
}

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'tangerine sailboat window';

let counter = 0;

function freshEmail(): string {
  counter += 1;
  return `reset-hist-${Date.now()}-${counter}@bas.lu`;
}

async function resetLinkFor(page: Page, email: string): Promise<string> {
  await page.goto('/sign-up', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Your name', { exact: true }).fill('History Tester');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  await page.goto('/forgot-password', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/__e2e/outbox');
        const mails = ((await res.json()) as SentMail[]).filter(
          (m) => m.to === email && /reset/i.test(m.subject),
        );
        link = /<(https?:\/\/[^>]+)>/.exec(mails[0]?.text ?? '')?.[1];
        return link;
      },
      { timeout: 10_000 },
    )
    .toBeTruthy();
  if (!link) throw new Error('reset link missing from the outbox');
  return link;
}

test.describe('reset token in history', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      HTMLCanvasElement.prototype.getContext = () => null;
    });
  });

  test('survives a reload, keeps other params and the hash, never touches web storage', async ({
    page,
  }) => {
    const link = await resetLinkFor(page, freshEmail());
    const redirect = await page.request.get(link, { maxRedirects: 0 });
    const landing = new URL(redirect.headers()['location'] ?? '', 'http://localhost');
    expect(landing.searchParams.get('token')).toBeTruthy();
    landing.searchParams.set('backend', 'webgl2');
    await page.goto(`${landing.pathname}${landing.search}#frag`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await expect(page).toHaveURL(/\/reset-password\?backend=webgl2#frag$/);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await expect(page).toHaveURL(/\/reset-password\?backend=webgl2#frag$/);

    const stored = await page.evaluate(() =>
      JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
    );
    expect(stored).not.toMatch(/token/i);
  });

  test('Back and Forward after success show password changed, not a dead link', async ({
    page,
  }) => {
    const link = await resetLinkFor(page, freshEmail());
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();

    await page.getByRole('link', { name: 'Sign in' }).last().click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();

    const state = await page.evaluate(() => JSON.stringify(history.state));
    expect(state).not.toMatch(/"aquariumResetToken":"/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();
  });

  test('a token rejected by the server shows the error on every later reload', async ({ page }) => {
    const link = await resetLinkFor(page, freshEmail());
    const redirect = await page.request.get(link, { maxRedirects: 0 });
    const landing = new URL(redirect.headers()['location'] ?? '', 'http://localhost');
    const token = landing.searchParams.get('token');
    expect(token).toBeTruthy();
    await page.goto(`${landing.pathname}${landing.search}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();

    const consumed = await page.request.post('/api/auth/reset-password', {
      data: { token, newPassword: NEW_PASSWORD },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(consumed.ok()).toBe(true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByLabel('New password', { exact: true }).fill(`${NEW_PASSWORD} again`);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByRole('heading', { name: 'That link did not work' })).toBeVisible();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'That link did not work' })).toBeVisible();
  });
});
