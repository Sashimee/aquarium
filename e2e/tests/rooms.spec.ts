import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  APP_URL,
  awaitLoaded,
  dockButton,
  openTank,
  registerVerifiedUser,
} from '../support/app.ts';
import {
  balance,
  createTank,
  errorOf,
  getTank,
  patchTank,
  purchase,
  sameOrigin,
  setBalance,
  wallet,
} from '../support/api.ts';
import { economy } from '../support/economy.ts';

const PAID = 'room-shop';
const OTHER_PAID = 'room-office';
const FREE = ['room-living', 'room-bedroom'];

async function shareTank(page: Page, tankId: string): Promise<string> {
  const shared = await page.request.post(`/api/tanks/${tankId}/share`, sameOrigin);
  expect(shared.ok(), 'enable sharing').toBe(true);
  return ((await shared.json()) as { shareToken: string }).shareToken;
}

async function freshVisitor(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    baseURL: APP_URL,
    viewport: { width: 800, height: 540 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  return context.newPage();
}

const ownedRooms = async (page: Page): Promise<string[]> =>
  ((await (await page.request.get('/api/rooms')).json()) as { owned: string[] }).owned;

test('the free rooms are usable at once, and a tank can go back to no room', async ({ page }) => {
  await registerVerifiedUser(page, 'freerooms');
  const tank = await createTank(page, { name: 'Pond' });
  expect(await ownedRooms(page)).toEqual([]);

  for (const room of FREE) {
    const set = await patchTank(page, tank.id, { roomId: room });
    expect(set.status(), room).toBe(200);
    expect((await getTank(page, tank.id)).roomId).toBe(room);
  }
  const cleared = await patchTank(page, tank.id, { roomId: null });
  expect(cleared.status()).toBe(200);
  expect((await getTank(page, tank.id)).roomId).toBeNull();
  expect((await wallet(page)).ledger.filter((r) => r.reason === 'purchase')).toEqual([]);

  const unknown = await patchTank(page, tank.id, { roomId: 'room-nowhere' });
  expect(unknown.status()).toBe(400);
});

test('a paid room is locked until bought, charged once, and then works in every tank', async ({
  page,
}) => {
  await registerVerifiedUser(page, 'paidroom');
  const home = await createTank(page, { name: 'Home' });
  const second = await createTank(page, { name: 'Second' });
  const price = economy.rooms[PAID];
  if (price === undefined) throw new Error(`${PAID} has no price`);

  const locked = await patchTank(page, home.id, { roomId: PAID });
  expect(locked.status()).toBe(409);
  expect((await errorOf(locked)).reason).toBe('room_not_owned');
  expect((await getTank(page, home.id)).roomId).toBe(home.roomId);

  const before = await balance(page);
  const bought = await purchase(page, `room:${PAID}`);
  expect(bought.status()).toBe(200);
  expect(await bought.json()).toMatchObject({
    replayed: false,
    wallet: { balance: before - price },
    entry: { delta: -price, reason: 'purchase', itemRef: `room:${PAID}` },
  });
  expect(await ownedRooms(page)).toEqual([PAID]);

  const again = await purchase(page, `room:${PAID}`);
  expect(again.status()).toBe(409);
  expect((await errorOf(again)).reason).toBe('room_already_owned');
  expect(await balance(page)).toBe(before - price);

  for (const tank of [home, second]) {
    expect((await patchTank(page, tank.id, { roomId: PAID })).status()).toBe(200);
    expect((await getTank(page, tank.id)).roomId).toBe(PAID);
  }
  const stillLocked = await patchTank(page, home.id, { roomId: OTHER_PAID });
  expect(stillLocked.status(), 'owning one room unlocks only that room').toBe(409);
});

test('a free room cannot be bought, a room is not bought per tank, and Pearls must cover the price', async ({
  page,
}) => {
  await registerVerifiedUser(page, 'roomrefusals');
  const tank = await createTank(page, { name: 'Pond' });

  expect((await purchase(page, 'room:room-living')).status()).toBe(400);
  expect((await purchase(page, `room:${PAID}`, { tankId: tank.id })).status()).toBe(400);
  expect((await purchase(page, 'room:room-nowhere')).status()).toBe(400);

  const price = economy.rooms[PAID] ?? 0;
  await setBalance(page, price - 1);
  const poor = await purchase(page, `room:${PAID}`);
  expect(poor.status()).toBe(402);
  expect((await errorOf(poor)).code).toBe('insufficient_pearls');
  expect(await balance(page)).toBe(price - 1);
  expect(await ownedRooms(page)).toEqual([]);

  await setBalance(page, price);
  expect((await purchase(page, `room:${PAID}`)).status()).toBe(200);
  expect(await balance(page)).toBe(0);
});

test('someone else cannot change or buy a room for your tank', async ({ page, browser }) => {
  await registerVerifiedUser(page, 'roomowner');
  const tank = await createTank(page, { name: 'Mine' });

  const stranger = await freshVisitor(browser);
  await registerVerifiedUser(stranger, 'roomstranger');
  const tried = await patchTank(stranger, tank.id, { roomId: 'room-bedroom' });
  expect([403, 404]).toContain(tried.status());
  expect((await getTank(page, tank.id)).roomId).toBe(tank.roomId);

  const anonymous = await freshVisitor(browser);
  const noSession = await patchTank(anonymous, tank.id, { roomId: 'room-bedroom' });
  expect(noSession.status()).toBe(401);
  await stranger.context().close();
  await anonymous.context().close();
});

test('a shared link and the gallery show the room read-only, and the room follows the owner', async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  await registerVerifiedUser(page, 'roomshare');
  const tank = await createTank(page, { name: 'Showcase' });
  expect((await purchase(page, `room:${PAID}`)).status()).toBe(200);
  expect((await patchTank(page, tank.id, { roomId: PAID })).status()).toBe(200);
  const token = await shareTank(page, tank.id);
  const listed = await page.request.put(`/api/tanks/${tank.id}/gallery`, {
    ...sameOrigin,
    data: { listed: true },
  });
  expect(listed.ok(), 'list in the gallery').toBe(true);

  const visitor = await freshVisitor(browser);
  const publicView = await visitor.request.get(`/api/public/${token}`);
  expect(await publicView.json()).toMatchObject({ roomId: PAID });
  const galleryView = await visitor.request.get(`/api/gallery/${tank.id}`);
  expect(await galleryView.json()).toMatchObject({ roomId: PAID });
  const entries = (await (await visitor.request.get('/api/gallery')).json()) as {
    entries: { id: string; roomId: string | null }[];
  };
  expect(entries.entries.find((e) => e.id === tank.id)?.roomId).toBe(PAID);

  const edit = await visitor.request.patch(`/api/tanks/${tank.id}`, {
    ...sameOrigin,
    data: { roomId: 'room-bedroom' },
  });
  expect(edit.status(), 'a visitor cannot move the room').toBe(401);

  await visitor.goto(`/t/${token}?tier=low&backend=webgl`);
  const readout = visitor.locator('.room-readout');
  await expect(readout).toHaveAttribute('data-room-id', PAID, { timeout: 180_000 });
  await expect(readout).toContainText('Aquarium shop');
  await expect(visitor.locator('.room-picker')).toHaveCount(0);

  await visitor.goto(`/gallery/${tank.id}?tier=low&backend=webgl`);
  await expect(visitor.locator('.room-readout')).toHaveAttribute('data-room-id', PAID, {
    timeout: 180_000,
  });
  await expect(visitor.locator('.room-picker')).toHaveCount(0);

  await patchTank(page, tank.id, { roomId: 'room-bedroom' });
  await visitor.reload();
  await expect(visitor.locator('.room-readout')).toHaveAttribute('data-room-id', 'room-bedroom', {
    timeout: 180_000,
  });
  await visitor.context().close();
});

test('the room picker in Decorate switches a free room, buys a paid one after asking, and shows it as owned', async ({
  page,
}) => {
  test.setTimeout(420_000);
  await registerVerifiedUser(page, 'roomui');
  const tank = await createTank(page, { name: 'Pond' });
  const price = economy.rooms[PAID];
  if (price === undefined) throw new Error(`${PAID} has no price`);
  await openTank(page);

  await dockButton(page, 'Decorate').click();
  const panel = page.getByRole('region', { name: 'Decorate the tank' });
  await expect(panel).toBeVisible({ timeout: 60_000 });
  const picker = panel.getByRole('group', { name: 'Room' });
  await expect(picker.locator('[data-room-id]')).toHaveCount(13);

  const room = (id: string) => picker.locator(`[data-room-id="${id}"]`);
  await expect(room(PAID)).toHaveAttribute('data-room-owned', 'false');
  await expect(room(PAID)).toContainText(`${price.toLocaleString('en')} Pearls`);
  await expect(room('room-bedroom')).toContainText('Free');

  await room('room-bedroom').click();
  await expect(room('room-bedroom')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await getTank(page, tank.id)).roomId).toBe('room-bedroom');

  await room(PAID).click();
  await expect(
    picker.getByText(`Buy the Aquarium shop for ${price.toLocaleString('en')} Pearls?`),
  ).toBeVisible();
  expect(await ownedRooms(page), 'asking first buys nothing').toEqual([]);
  await picker.getByRole('button', { name: 'Yes, buy it' }).click();

  await expect(room(PAID)).toHaveAttribute('data-room-owned', 'true', { timeout: 60_000 });
  await expect(room(PAID)).toHaveAttribute('aria-pressed', 'true');
  await expect(room(PAID)).toContainText('Owned');
  await expect.poll(async () => (await getTank(page, tank.id)).roomId).toBe(PAID);
  expect(await ownedRooms(page)).toEqual([PAID]);

  await room('none').click();
  await expect.poll(async () => (await getTank(page, tank.id)).roomId).toBeNull();
  await awaitLoaded(page);
});

test.describe('the old per-device room (T78 migration)', () => {
  const DEVICE_KEY = 'aquarium.room';

  async function withDeviceRoom(page: Page, value: string): Promise<void> {
    await page.goto('/?tier=low&backend=webgl');
    await page.evaluate(
      ([key, room]) => localStorage.setItem(key as string, room as string),
      [DEVICE_KEY, value],
    );
  }

  const deviceRoom = (page: Page) => page.evaluate((key) => localStorage.getItem(key), DEVICE_KEY);

  test('a stored "none" moves untouched tanks once and leaves a tank the player set alone', async ({
    page,
  }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'migrate');
    const untouched = await createTank(page, { name: 'Untouched' });
    const chosen = await createTank(page, { name: 'Chosen' });
    expect((await getTank(page, untouched.id)).roomId).toBe('room-living');
    expect((await patchTank(page, chosen.id, { roomId: 'room-bedroom' })).status()).toBe(200);

    await withDeviceRoom(page, 'none');
    await openTank(page);

    await expect.poll(async () => (await getTank(page, untouched.id)).roomId).toBeNull();
    await expect.poll(() => deviceRoom(page), { message: 'the device key is dropped' }).toBeNull();
    expect((await getTank(page, chosen.id)).roomId, 'a room the player set is kept').toBe(
      'room-bedroom',
    );

    expect((await patchTank(page, untouched.id, { roomId: 'room-living' })).status()).toBe(200);
    await openTank(page);
    expect((await getTank(page, untouched.id)).roomId, 'it never runs a second time').toBe(
      'room-living',
    );
  });

  test('a stored paid room is applied only when the account owns it', async ({ page }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'migrateowned');
    const tank = await createTank(page, { name: 'Pond' });

    await withDeviceRoom(page, 'office');
    await openTank(page);
    await expect.poll(() => deviceRoom(page)).toBeNull();
    expect((await getTank(page, tank.id)).roomId, 'an unowned room is not applied').toBe(
      'room-living',
    );

    const bought = await purchase(page, `room:${OTHER_PAID}`);
    expect(bought.status(), await bought.text()).toBe(200);
    await withDeviceRoom(page, 'office');
    await openTank(page);
    await expect.poll(async () => (await getTank(page, tank.id)).roomId).toBe(OTHER_PAID);
    await expect.poll(() => deviceRoom(page)).toBeNull();
  });

  test('a stored value that is not one of the old rooms is dropped and changes nothing', async ({
    page,
  }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'migratejunk');
    const tank = await createTank(page, { name: 'Pond' });
    await withDeviceRoom(page, 'a-room-that-never-existed');
    await openTank(page);
    await expect.poll(() => deviceRoom(page)).toBeNull();
    expect((await getTank(page, tank.id)).roomId).toBe('room-living');
  });
});
