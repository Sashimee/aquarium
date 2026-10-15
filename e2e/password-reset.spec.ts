import { expect, test, type Browser, type Page } from '@playwright/test';
import { openAccount } from './support/app.ts';

interface SentMail {
  to: string;
  subject: string;
  text: string;
}

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'tangerine sailboat window';

const signedIn = (page: Page) => page.getByRole('button', { name: 'Account, Reset Tester' });

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

let counter = 0;
function freshEmail(): string {
  counter += 1;
  return `reset-${Date.now()}-${counter}@bas.lu`;
}

async function mailsTo(page: Page, to: string, subject: RegExp): Promise<string[]> {
  const res = await page.request.get('/__e2e/outbox');
  const all = (await res.json()) as SentMail[];
  return all
    .filter((m) => m.to === to && subject.test(m.subject))
    .map((m) => {
      const link = /<(https?:\/\/[^>]+)>/.exec(m.text);
      if (!link?.[1]) throw new Error(`No link in mail "${m.subject}" to ${to}`);
      return link[1];
    });
}

async function waitForLink(page: Page, to: string, subject: RegExp, count = 1): Promise<string> {
  let links: string[] = [];
  await expect
    .poll(async () => (links = await mailsTo(page, to, subject)).length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(count);
  const link = links[count - 1];
  if (!link) throw new Error('unreachable');
  return link;
}

async function signUp(page: Page, email: string): Promise<void> {
  await open(page, '/sign-up');
  await page.getByLabel('Your name', { exact: true }).fill('Reset Tester');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
}

async function submitSignIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function requestReset(page: Page, email: string): Promise<void> {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
}

const withoutWebGl = () => {
  HTMLCanvasElement.prototype.getContext = () => null;
};

async function newContextPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript(withoutWebGl);
  return context.newPage();
}

test.describe('password reset', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(withoutWebGl);
  });

  test('forgot password, reset, and sign in with the new password only', async ({ page }) => {
    const email = freshEmail();
    await signUp(page, email);
    await open(page, await waitForLink(page, email, /verify/i));
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
    await openAccount(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('link', { name: 'Create account' })).toBeVisible();

    await open(page, '/sign-in');
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await requestReset(page, email);

    await open(page, await waitForLink(page, email, /reset/i));
    await expect(page).toHaveURL(/\/reset-password$/);
    await page.getByLabel('New password', { exact: true }).fill('short');
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByText('Use at least 10 characters.')).toBeVisible();

    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();

    await page.getByRole('link', { name: 'Sign in' }).last().click();
    await submitSignIn(page, email, PASSWORD);
    await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toBeVisible();
    await submitSignIn(page, email, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/$/);
    await expect(signedIn(page)).toBeVisible();
  });

  test('a used reset link lands on the expired state', async ({ page }) => {
    const email = freshEmail();
    await signUp(page, email);
    await open(page, '/forgot-password');
    await requestReset(page, email);
    const link = await waitForLink(page, email, /reset/i);

    await open(page, link);
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();

    await open(page, link);
    await expect(page).toHaveURL(/\/reset-password\?error=INVALID_TOKEN/);
    await expect(page.getByRole('heading', { name: 'That link did not work' })).toBeVisible();
    await page.getByRole('link', { name: 'Send a new reset link' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
  });

  test('a reset page without a token shows the expired state', async ({ page }) => {
    await open(page, '/reset-password');
    await expect(page.getByRole('heading', { name: 'That link did not work' })).toBeVisible();
  });

  test('verifying on another device drops the password; sign-in hints at reset', async ({
    page,
    browser,
  }) => {
    const email = freshEmail();
    await signUp(page, email);
    await expect(page.getByText('Open the link in this same browser')).toBeVisible();
    const verifyLink = await waitForLink(page, email, /verify/i);

    const phone = await newContextPage(browser);
    await open(phone, verifyLink);
    await expect(phone.getByRole('heading', { name: 'Email verified' })).toBeVisible();

    await open(page, '/sign-in');
    await submitSignIn(page, email, PASSWORD);
    const hint = page.getByRole('note');
    await expect(hint).toContainText('Forgot password');
    await hint.getByRole('link', { name: 'Forgot password' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await requestReset(page, email);

    await open(page, await waitForLink(page, email, /reset/i));
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();

    await page.getByRole('link', { name: 'Sign in' }).last().click();
    await submitSignIn(page, email, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/$/);
    await expect(signedIn(page)).toBeVisible();
    await phone.context().close();
  });

  test('resetting on a device that is still signed in lands on a working sign-in', async ({
    page,
    browser,
  }) => {
    const email = freshEmail();
    await signUp(page, email);
    await open(page, await waitForLink(page, email, /verify/i));
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
    await expect(signedIn(page)).toBeVisible();

    const desktop = await newContextPage(browser);
    await open(desktop, '/forgot-password');
    await requestReset(desktop, email);
    await desktop.context().close();

    await open(page, await waitForLink(page, email, /reset/i));
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await expect(page).toHaveURL(/\/reset-password$/);
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();
    await expect(signedIn(page)).toBeHidden();

    await page.getByRole('link', { name: 'Sign in' }).last().click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await submitSignIn(page, email, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/$/);
    await expect(signedIn(page)).toBeVisible();
  });
});
