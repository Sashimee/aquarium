import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { APP_URL, PASSWORD, registerVerifiedUser, verificationLinkFor } from '../support/app.ts';
import { balance, createTank, errorOf, me, purchase, sameOrigin } from '../support/api.ts';
import { economy } from '../support/economy.ts';
import { setHandle, uniqueHandle } from '../support/social.ts';
import { signUpStatus } from '../support/signup.ts';

const ROOM = 'room-office';

interface DataExport {
  format: string;
  user: { id: string; email: string; handle: string | null };
  wallet: { balance: number; ledger: { reason: string; itemRef: string | null }[] };
  ownedRooms: { roomId: string }[];
  tanks: { tank: { name: string } }[];
}

async function lightSettings(page: Page): Promise<void> {
  await page.route('**/assets/**', (route) => {
    const { pathname } = new URL(route.request().url());
    return /\.(js|css)$/.test(pathname) ? route.continue() : route.abort();
  });
}

async function ownerWithRoom(page: Page, label: string) {
  const identity = await registerVerifiedUser(page, label);
  const startBalance = await balance(page);
  await createTank(page, { name: 'Pond' });
  const handle = uniqueHandle('acct');
  const named = await setHandle(page, handle);
  expect(named.ok(), await named.text()).toBe(true);
  const bought = await purchase(page, `room:${ROOM}`);
  expect(bought.status(), await bought.text()).toBe(200);
  return { identity, handle, startBalance };
}

test.describe('your data and deleting the account', () => {
  test('the export holds the wallet, the handle and the rooms you own', async ({ page }) => {
    const { identity, handle } = await ownerWithRoom(page, 'export');
    const spent = economy.rooms[ROOM] ?? 0;
    const left = await balance(page);

    const res = await page.request.post('/api/me/export', sameOrigin);
    expect(res.status(), await res.text()).toBe(200);
    expect(res.headers()['content-disposition']).toContain('aquarium-data.json');
    const data = (await res.json()) as DataExport;

    expect(data.format).toBe('aquarium-export-v1');
    expect(data.user.email).toBe(identity.email);
    expect(data.user.handle).toBe(handle);
    expect(data.wallet.balance).toBe(left);
    expect(data.wallet.ledger.some((row) => row.itemRef === `room:${ROOM}`)).toBe(true);
    expect(data.ownedRooms.map((r) => r.roomId)).toEqual([ROOM]);
    expect(data.tanks.map((t) => t.tank.name)).toEqual(['Pond']);
    expect(spent).toBeGreaterThan(0);
  });

  test('the settings page warns that unspent Pearls are lost, and the button downloads the export', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await lightSettings(page);
    const { handle } = await ownerWithRoom(page, 'exportui');

    await page.goto('/settings?backend=webgl&tier=low');
    const data = page.getByRole('region', { name: 'Your data' });
    const download = page.waitForEvent('download');
    await data.getByRole('button', { name: 'Export my data' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('aquarium-data.json');
    await expect(data.getByRole('status')).toContainText('Your download has started.');

    const path = await file.path();
    const exported = JSON.parse(readFileSync(path, 'utf8')) as DataExport;
    expect(exported.user.handle).toBe(handle);
    expect(exported.ownedRooms.map((r) => r.roomId)).toEqual([ROOM]);
    expect(exported.wallet.balance).toBeGreaterThan(0);

    const danger = page.getByRole('region', { name: 'Delete account' });
    await expect(danger).toContainText(
      'Any Pearls you have not spent are lost, the ones you bought included. It cannot be undone.',
    );
  });

  test('a wrong password deletes nothing, and the right one removes the account, its Pearls and its rooms', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await lightSettings(page);
    const { identity, startBalance } = await ownerWithRoom(page, 'delete');
    const userId = (await me(page)).id;

    await page.goto('/settings?backend=webgl&tier=low');
    const danger = page.getByRole('region', { name: 'Delete account' });
    await danger.getByRole('button', { name: 'Delete account' }).click();
    await danger.getByLabel('Password').fill('not the password at all');
    await danger.getByRole('button', { name: 'Permanently delete my account' }).click();
    await expect(danger.getByRole('alert')).toContainText(
      'Password confirmation is required and must be correct.',
    );
    expect((await me(page)).id, 'the account is still there').toBe(userId);

    await danger.getByLabel('Password').fill(PASSWORD);
    await danger.getByRole('button', { name: 'Permanently delete my account' }).click();
    await expect(page).toHaveURL(`${APP_URL}/`);

    const gone = await page.request.get('/api/me');
    expect(gone.status()).toBeGreaterThanOrEqual(400);
    expect(gone.status()).toBeLessThan(500);
    const signIn = await page.request.post('/api/auth/sign-in/email', {
      ...sameOrigin,
      data: { email: identity.email, password: PASSWORD },
    });
    expect(signIn.ok(), 'the deleted account cannot sign in').toBe(false);

    const again = await signUpStatus(page, APP_URL, identity);
    expect(again.ok, `signing up again with the same address (status ${again.status})`).toBe(true);
    const verified = await page.request.get(await verificationLinkFor(identity.email));
    expect(verified.ok()).toBe(true);
    const reborn = await me(page);
    expect(reborn.id, 'a new account, not the old one').not.toBe(userId);
    expect(await balance(page), 'the old Pearls did not come back').toBe(startBalance);
    const rooms = (await (await page.request.get('/api/rooms')).json()) as { owned: string[] };
    expect(rooms.owned).toEqual([]);
    expect(((await (await page.request.get('/api/tanks')).json()) as unknown[]).length).toBe(0);
    const exported = (await (
      await page.request.post('/api/me/export', sameOrigin)
    ).json()) as DataExport;
    expect(exported.user.handle).toBeNull();
    expect(exported.ownedRooms).toEqual([]);
    expect(exported.wallet.ledger.some((row) => row.itemRef === `room:${ROOM}`)).toBe(false);
  });

  test('deleting without being signed in is refused', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: APP_URL, serviceWorkers: 'block' });
    const res = await context.request.post('/api/me/delete', {
      ...sameOrigin,
      data: { password: PASSWORD },
    });
    expect(res.status()).toBe(401);
    expect((await errorOf(res)).code).toBeTruthy();
    await context.close();
  });
});
