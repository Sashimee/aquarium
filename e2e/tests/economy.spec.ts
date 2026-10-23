import { expect, test } from '@playwright/test';
import { openDock, openTank, registerVerifiedUser } from '../support/app.ts';
import {
  addFish,
  addFishRaw,
  balance,
  createTank,
  errorOf,
  getTank,
  key,
  purchase,
  sameOrigin,
  setBalance,
  wallet,
} from '../support/api.ts';
import { economy } from '../support/economy.ts';

const BACKGROUND = 'bg-fw-root-tangle';
const BACKGROUND_REF = `background:${BACKGROUND}`;
const BACKGROUND_PRICE = economy.items.background.price;

test('the wallet starts funded, and the ledger sums to the balance', async ({ page }) => {
  await registerVerifiedUser(page, 'wallet');
  const { wallet: held, ledger, owned } = await wallet(page);

  expect(held.balance).toBeGreaterThan(0);
  expect(ledger.some((row) => row.reason === 'grant' && row.delta > 0)).toBe(true);
  expect(ledger.reduce((sum, row) => sum + row.delta, 0)).toBe(held.balance);
  expect(owned).not.toContain(BACKGROUND_REF);
});

test('a purchase charges the price once, replays on the same key, and refuses a duplicate or a mixed-up key', async ({
  page,
}) => {
  await registerVerifiedUser(page, 'buy');
  const tank = await createTank(page, { name: 'Pond' });
  const before = await balance(page);
  const sameKey = key();

  const first = await purchase(page, BACKGROUND_REF, { tankId: tank.id, idempotencyKey: sameKey });
  expect(first.status()).toBe(200);
  expect(await first.json()).toMatchObject({
    replayed: false,
    wallet: { balance: before - BACKGROUND_PRICE },
    entry: { delta: -BACKGROUND_PRICE, reason: 'purchase', itemRef: BACKGROUND_REF },
  });
  expect((await getTank(page, tank.id)).backgroundId).toBe(BACKGROUND);

  const replay = await purchase(page, BACKGROUND_REF, { tankId: tank.id, idempotencyKey: sameKey });
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toMatchObject({ replayed: true });
  expect(await balance(page), 'a retry is not charged twice').toBe(before - BACKGROUND_PRICE);

  const again = await purchase(page, BACKGROUND_REF, { tankId: tank.id });
  expect(again.status()).toBe(409);
  expect((await errorOf(again)).message).toContain('already own');

  const mixedUp = await purchase(page, 'decor:boulder-01', {
    tankId: tank.id,
    idempotencyKey: sameKey,
  });
  expect(mixedUp.status()).toBe(409);
  expect((await errorOf(mixedUp)).message).toContain('different item');
  expect(await balance(page)).toBe(before - BACKGROUND_PRICE);

  const { owned, ledger } = await wallet(page);
  expect(owned).toContain(BACKGROUND_REF);
  expect(ledger.filter((row) => row.itemRef === BACKGROUND_REF)).toHaveLength(1);
});

test('things that are not for sale in the shop are refused without a charge', async ({ page }) => {
  await registerVerifiedUser(page, 'notforsale');
  const tank = await createTank(page, { name: 'Pond' });
  const before = await balance(page);

  const refused = [
    { ref: 'species:neon-tetra:juvenile', tankId: tank.id },
    { ref: 'tank:standard:anything', tankId: undefined },
    { ref: 'plant:java-fern', tankId: undefined },
    { ref: 'background:no-such-background', tankId: tank.id },
    { ref: 'room:room-living', tankId: undefined },
    { ref: 'room:room-nowhere', tankId: undefined },
    { ref: 'room:room-shop', tankId: tank.id },
    { ref: 'equipment:heater:9', tankId: tank.id },
    { ref: 'nonsense', tankId: tank.id },
  ];
  for (const { ref, tankId } of refused) {
    const res = await purchase(page, ref, tankId ? { tankId } : {});
    expect(res.status(), `${ref} is refused`).toBeGreaterThanOrEqual(400);
    expect(res.status(), `${ref} is a client error`).toBeLessThan(500);
  }
  expect(await balance(page)).toBe(before);
  expect((await wallet(page)).ledger.filter((row) => row.reason === 'purchase')).toEqual([]);
});

test('an adult costs more than a juvenile, as the price list says', async ({ page }) => {
  await registerVerifiedUser(page, 'stage');
  const tank = await createTank(page, { name: 'Pond' });
  const price = economy.species['neon-tetra'];
  if (!price) throw new Error('neon-tetra has no price in content/economy.json');

  await addFish(page, tank.id, 'neon-tetra', { stage: 'juvenile' });
  await addFish(page, tank.id, 'neon-tetra', { stage: 'adult' });

  const { ledger } = await wallet(page);
  const delta = (ref: string) => ledger.find((row) => row.itemRef === ref)?.delta;
  expect(delta('species:neon-tetra:juvenile')).toBe(-price.juvenile);
  expect(delta('species:neon-tetra:adult')).toBe(-price.adult);
  expect(price.adult).toBeGreaterThan(price.juvenile);
});

test('with too few Pearls a purchase is refused with 402 and nothing changes', async ({ page }) => {
  await registerVerifiedUser(page, 'poor');
  const tank = await createTank(page, { name: 'Pond' });
  const adult = economy.species['neon-tetra']?.adult ?? 0;
  await setBalance(page, adult - 1);

  const fish = await addFishRaw(page, tank.id, 'neon-tetra', { stage: 'adult' });
  expect(fish.status()).toBe(402);
  expect((await errorOf(fish)).code).toBe('insufficient_pearls');
  expect((await getTank(page, tank.id)).fish).toHaveLength(0);

  const background = await purchase(page, BACKGROUND_REF, { tankId: tank.id });
  expect(background.status()).toBe(402);
  expect((await errorOf(background)).code).toBe('insufficient_pearls');

  const room = await purchase(page, 'room:room-shop');
  expect(room.status()).toBe(402);

  expect(await balance(page)).toBe(adult - 1);
  expect((await wallet(page)).owned).toEqual([]);
});

test('at zero Pearls free care still works, a priced consumable does not, and the shop says so', async ({
  page,
}) => {
  test.setTimeout(420_000);
  await registerVerifiedUser(page, 'broke');
  const tank = await createTank(page, { name: 'Pond' });
  await addFish(page, tank.id, 'neon-tetra');
  await setBalance(page, 0);

  const care = (data: Record<string, unknown>) =>
    page.request.post(`/api/tanks/${tank.id}/care`, { ...sameOrigin, data });

  const dose = await care({ type: 'bottled_bacteria', idempotencyKey: key() });
  expect(dose.status()).toBe(402);
  expect((await errorOf(dose)).code).toBe('insufficient_pearls');

  expect((await care({ type: 'water_change' })).ok(), 'a water change is free').toBe(true);
  expect((await care({ type: 'gravel_vacuum' })).ok(), 'gravel vacuuming is free').toBe(true);
  expect(
    await balance(page),
    'free care may pay a reward, never takes Pearls',
  ).toBeGreaterThanOrEqual(0);

  await openTank(page);
  await expect(page.getByRole('button', { name: /^[\d,]+ Pearls, about €/ })).toBeVisible();
  const shop = await openDock(page, 'Shop', 'Fish shop');
  await expect(shop.getByRole('heading', { name: 'Choose a fish' })).toBeVisible();
});

test('the Pearl balance on the HUD and the price in the shop show their euro value', async ({
  page,
}) => {
  test.setTimeout(420_000);
  await registerVerifiedUser(page, 'hud');
  await createTank(page, { name: 'Pond' });
  await openTank(page);

  const hud = page.getByRole('button', { name: /Pearls, about €.*Open the shop/ });
  await expect(hud).toBeVisible();
  const label = (await hud.getAttribute('aria-label')) ?? '';
  const [, pearls, euros] =
    /^([\d,]+) Pearls, about €(\d+\.\d\d)\. Open the shop$/.exec(label) ?? [];
  expect(pearls, label).toBeDefined();
  const count = Number(pearls?.replaceAll(',', ''));
  expect(Number(euros)).toBeCloseTo((count * economy.pearlValueCents) / 100, 2);

  const shop = await openDock(page, 'Shop', 'Fish shop');
  const neon = economy.species['neon-tetra'];
  if (!neon) throw new Error('neon-tetra has no price in content/economy.json');
  const row = shop.getByRole('listitem').filter({ hasText: 'Neon tetra' }).first();
  await expect(row).toContainText(
    `${neon.juvenile} Pearls (about €${(neon.juvenile / 100).toFixed(2)})`,
  );

  await shop
    .getByRole('group', { name: 'Size when bought' })
    .getByRole('button', { name: 'Adult' })
    .click();
  await expect(row).toContainText(`${neon.adult} Pearls (about €${(neon.adult / 100).toFixed(2)})`);
});

test('buying an adult fish in the shop asks first, then charges the price', async ({ page }) => {
  test.setTimeout(420_000);
  await registerVerifiedUser(page, 'shopbuy');
  await createTank(page, { name: 'Pond' });
  await openTank(page);

  const shop = await openDock(page, 'Shop', 'Fish shop');
  const neon = economy.species['neon-tetra'];
  if (!neon) throw new Error('neon-tetra has no price in content/economy.json');
  await shop
    .getByRole('group', { name: 'Size when bought' })
    .getByRole('button', { name: 'Adult' })
    .click();
  const row = shop.getByRole('listitem').filter({ hasText: 'Neon tetra' }).first();
  await row.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(shop.getByText(`Buy Neon tetra for ${neon.adult} Pearls?`)).toBeVisible();
  await shop.getByRole('button', { name: 'Yes, buy it' }).click();
  await expect(shop).toContainText('1 of 60 animals', { timeout: 60_000 });

  const charged = (await wallet(page)).ledger.find((r) => r.itemRef === 'species:neon-tetra:adult');
  expect(charged?.delta).toBe(-neon.adult);
});
