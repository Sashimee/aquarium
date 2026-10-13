import { expect, test, type Page } from '@playwright/test';
import {
  newIdentity,
  PASSWORD,
  registerVerifiedUser,
  verificationLinkFor,
} from '../support/app.ts';

// These flows never look at the tank, so the scene's models and textures are not worth rendering
// in software on every page load. The scripts, styles and API still load for real.
async function skipSceneAssets(page: Page): Promise<void> {
  await page.route('**/assets/**', (route) => {
    const { pathname } = new URL(route.request().url());
    return /\.(js|css)$/.test(pathname) ? route.continue() : route.abort();
  });
}

async function submitSignIn(page: Page, email: string): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('sign up, verify through the outbox, then sign in', async ({ page }) => {
  const { name, email } = newIdentity('signup');
  await skipSceneAssets(page);
  const account = page.getByRole('navigation', { name: 'Account' });

  await page.goto('/sign-up?backend=webgl');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

  await page.getByRole('link', { name: 'Go to sign in' }).click();
  await submitSignIn(page, email);
  await expect(
    page.getByText('Email not verified'),
    'sign-in is refused before verifying',
  ).toBeVisible();
  await expect(account.getByText(name)).toBeHidden();

  await page.goto(await verificationLinkFor(email));
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
  await expect(account.getByText(name)).toBeVisible();

  await account.getByRole('button', { name: 'Sign out' }).click();
  await expect(account.getByRole('link', { name: 'Sign in' })).toBeVisible();

  await account.getByRole('link', { name: 'Sign in' }).click();
  await submitSignIn(page, email);
  await expect(account.getByText(name)).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
});

test('a passkey on a virtual authenticator registers and signs in', async ({ page, context }) => {
  await skipSceneAssets(page);
  const { name } = await registerVerifiedUser(page, 'passkey');
  const account = page.getByRole('navigation', { name: 'Account' });

  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const credentials = async () =>
    (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;

  await page.goto('/settings?backend=webgl');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByText('Passkey added.')).toBeVisible();
  expect(await credentials()).toHaveLength(1);

  await account.getByRole('button', { name: 'Sign out' }).click();
  await expect(account.getByRole('link', { name: 'Sign in' })).toBeVisible();

  await account.getByRole('link', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(account.getByText(name)).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await expect.poll(async () => (await credentials())[0]?.signCount).toBeGreaterThan(0);
});
