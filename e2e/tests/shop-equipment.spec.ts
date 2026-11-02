import { expect, test, type Locator } from '@playwright/test';
import { openDock, openTank, registerVerifiedUser } from '../support/app.ts';
import {
  balance,
  createTank,
  errorOf,
  purchase,
  setBalance,
  wallet,
  type Wallet,
} from '../support/api.ts';
import { economy } from '../support/economy.ts';
import { readTank } from '../support/life.ts';

const prices = economy.items.equipment;
const price = (device: string, tier: number): number => {
  const value = prices[device]?.[tier - 1];
  if (value === undefined) throw new Error(`no price for ${device} tier ${tier}`);
  return value;
};

const pearls = (n: number): string => `${n.toLocaleString('en')} Pearls`;
const euros = (pearlCount: number): string =>
  `€${((pearlCount * economy.pearlValueCents) / 100).toFixed(2)}`;

function shortfallSentence(cost: number, have: number): string {
  const short = cost - have;
  const pack = economy.packs
    .filter((p) => p.webAvailable && p.pearls >= short)
    .sort((a, b) => a.pearls - b.pearls)[0];
  if (!pack) throw new Error(`no web pack covers ${short} Pearls`);
  return (
    `This costs ${pearls(cost)} and you have ${pearls(have)}, so you are ${pearls(short)} short. ` +
    `The smallest pack that covers it is ${pearls(pack.pearls)} for €${(pack.priceCents / 100).toFixed(2)}, ` +
    `which leaves you ${pearls(pack.pearls - short)} afterwards.`
  );
}

const deviceRow = (shop: Locator, label: string): Locator =>
  shop
    .getByRole('region', { name: 'Equipment' })
    .getByRole('listitem')
    .filter({ has: shop.page().getByRole('heading', { name: label, exact: true }) })
    .first();

const equipmentCharges = (w: Wallet): { itemRef: string | null; delta: number }[] =>
  w.ledger.filter((row) => row.itemRef?.startsWith('equipment:'));

test.describe('equipment tiers', () => {
  test('each tier is bought at its own price, installs at once, and never steps down', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'tiers');
    const pond = await createTank(page, { name: 'Pond' });
    const start = await balance(page);

    const heater2 = await purchase(page, 'equipment:heater:2', { tankId: pond.id });
    expect(heater2.status(), await heater2.text()).toBe(200);
    expect((await readTank(page, pond.id)).equipment.heater.tier).toBe(2);
    expect(await balance(page)).toBe(start - price('heater', 2));

    const sameTier = await purchase(page, 'equipment:heater:2', { tankId: pond.id });
    expect(sameTier.status(), 'the tier already installed is not sold again').toBe(409);
    const lower = await purchase(page, 'equipment:heater:1', { tankId: pond.id });
    expect(lower.status(), 'a lower tier is not sold as a downgrade').toBe(409);
    expect((await readTank(page, pond.id)).equipment.heater.tier).toBe(2);

    const skipped = await purchase(page, 'equipment:filter:3', { tankId: pond.id });
    expect(skipped.status(), await skipped.text()).toBe(200);
    expect((await readTank(page, pond.id)).equipment.filter.tier).toBe(3);
    expect(equipmentCharges(await wallet(page)).map((r) => [r.itemRef, r.delta])).toEqual([
      ['equipment:filter:3', -price('filter', 3)],
      ['equipment:heater:2', -price('heater', 2)],
    ]);
    expect(await balance(page), 'skipping tiers pays only the tier chosen').toBe(
      start - price('heater', 2) - price('filter', 3),
    );

    const afterBuying = await balance(page);
    const noTank = await purchase(page, 'equipment:light:2');
    expect(noTank.status(), 'equipment needs a tank to go into').toBeGreaterThanOrEqual(400);
    expect(noTank.status()).toBeLessThan(500);
    const beyond = await purchase(page, `equipment:heater:${(prices['heater']?.length ?? 0) + 1}`, {
      tankId: pond.id,
    });
    expect(beyond.status()).toBeGreaterThanOrEqual(400);
    expect(await balance(page)).toBe(afterBuying);
  });

  test('a reef takes a wave maker but no CO2, and a freshwater tank the other way round', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'devices');
    const reef = await createTank(page, { name: 'Reef', biome: 'reef' });
    const pond = await createTank(page, { name: 'Pond' });
    const before = await balance(page);

    const co2InReef = await purchase(page, 'equipment:co2:1', { tankId: reef.id });
    expect(co2InReef.status()).toBeGreaterThanOrEqual(400);
    expect(co2InReef.status()).toBeLessThan(500);
    expect((await readTank(page, reef.id)).equipment.co2.tier).toBe(0);
    expect(await balance(page), 'a refused device costs nothing').toBe(before);

    const waveMaker = await purchase(page, 'equipment:waveMaker:1', { tankId: reef.id });
    expect(waveMaker.status(), await waveMaker.text()).toBe(200);
    expect((await readTank(page, reef.id)).equipment.waveMaker.tier).toBe(1);

    const co2 = await purchase(page, 'equipment:co2:1', { tankId: pond.id });
    expect(co2.status(), await co2.text()).toBe(200);
    const bubbling = await readTank(page, pond.id);
    expect(bubbling.equipment.co2.tier).toBe(1);
    expect(bubbling.co2OwnedTier).toBe(1);
  });

  test('the shop shows what is installed, what skipping costs, and installs a bought tier', async ({
    page,
  }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'tiershop');
    await createTank(page, { name: 'Pond' });
    await openTank(page);
    const shop = await openDock(page, 'Shop', 'Fish shop');

    const heater = deviceRow(shop, 'Heater');
    await expect(heater).toContainText('Installed: tier 1.');
    await expect(heater.getByRole('button', { name: 'Heater tier 1 is installed' })).toBeDisabled();
    await expect(heater).toContainText("This skips a tier; you pay this tier's own price.");

    const top = prices['heater']?.length ?? 0;
    const buy = heater.getByRole('button', {
      name: `Buy Heater tier ${top} for ${price('heater', top)} Pearls, about ${euros(price('heater', top))}`,
    });
    const before = await balance(page);
    await buy.click();
    await expect(shop.locator('p.confirm')).toHaveText(
      `Buy Heater tier ${top} for ${pearls(price('heater', top))}? You will have ${pearls(before - price('heater', top))} left.`,
    );
    await shop.getByRole('button', { name: 'Yes, buy it' }).click();

    await expect(heater).toContainText(`Installed: tier ${top}.`);
    await expect(
      heater.getByRole('button', { name: `Heater tier ${top} is installed` }),
    ).toBeDisabled();
    await expect(heater.getByRole('button', { name: 'Heater tier 2 is not sold' })).toBeDisabled();
    await expect(heater).toContainText('Not sold: the tank already has a better one');
    expect(await balance(page)).toBe(before - price('heater', top));
  });

  test('a reef offers a wave maker and no CO2 system', async ({ page }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'reefshop');
    await createTank(page, { name: 'Reef', biome: 'reef' });
    await openTank(page);
    const shop = await openDock(page, 'Shop', 'Fish shop');
    const equipment = shop.getByRole('region', { name: 'Equipment' });
    await expect(equipment.getByRole('heading', { name: 'Wave maker', exact: true })).toBeVisible();
    await expect(equipment.getByRole('heading', { name: 'Lamp', exact: true })).toBeVisible();
    await expect(equipment.getByRole('heading', { name: 'CO₂ system', exact: true })).toHaveCount(
      0,
    );
  });
});

test.describe('warm-water species', () => {
  test('the catalogue marks the species that need a heater, and not all of them', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'warm');
    const res = await page.request.get('/api/species');
    expect(res.ok()).toBe(true);
    const species = (await res.json()) as { id: string; warmWater: boolean }[];
    expect(species.filter((s) => s.warmWater).length).toBeGreaterThan(0);
    expect(species.filter((s) => !s.warmWater).length).toBeGreaterThan(0);
  });
});

test.describe('not enough Pearls', () => {
  test('buying a fish you cannot afford names the gap, the smallest pack and what is left', async ({
    page,
  }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'short');
    const pond = await createTank(page, { name: 'Pond' });
    const adult = economy.species['neon-tetra']?.adult ?? 0;
    const have = 10;
    await setBalance(page, have);
    await openTank(page);
    const shop = await openDock(page, 'Shop', 'Fish shop');

    await shop
      .getByRole('group', { name: 'Size when bought' })
      .getByRole('button', { name: 'Adult' })
      .click();
    await shop
      .getByRole('listitem')
      .filter({ hasText: 'Neon tetra' })
      .first()
      .getByRole('button', { name: 'Add', exact: true })
      .click();

    const note = shop.locator('p.shortfall');
    await expect(note).toHaveText(shortfallSentence(adult, have));
    await expect(shop.getByText('Nothing is charged until you choose to buy')).toBeVisible();
    await expect(shop.getByRole('link', { name: 'See the Pearl packs' })).toBeVisible();
    expect(await balance(page), 'nothing was charged').toBe(have);
    expect((await readTank(page, pond.id)).fish).toHaveLength(0);

    await shop.getByRole('button', { name: 'Close this note' }).click();
    await expect(shop.locator('p.shortfall')).toHaveCount(0);
  });

  test('a lamp you cannot afford says the same, with the equipment price', async ({ page }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'shortlamp');
    await createTank(page, { name: 'Pond' });
    const topLamp = prices['light']?.length ?? 0;
    const cost = price('light', topLamp);
    const have = cost - 700;
    await setBalance(page, have);
    await openTank(page);
    const shop = await openDock(page, 'Shop', 'Fish shop');

    await deviceRow(shop, 'Lamp')
      .getByRole('button', { name: new RegExp(`^Buy Lamp tier ${topLamp} `) })
      .click();
    await expect(shop.locator('p.shortfall')).toHaveText(shortfallSentence(cost, have));
    await expect(shop.getByRole('button', { name: 'Yes, buy it' })).toHaveCount(0);
    expect(await balance(page)).toBe(have);
  });

  test('the same purchase through the API is a 402 that changes nothing', async ({ page }) => {
    await registerVerifiedUser(page, 'short402');
    const pond = await createTank(page, { name: 'Pond' });
    await setBalance(page, price('light', 2) - 1);
    const res = await purchase(page, 'equipment:light:2', { tankId: pond.id });
    expect(res.status()).toBe(402);
    expect((await errorOf(res)).code).toBe('insufficient_pearls');
    expect((await readTank(page, pond.id)).equipment.light.tier).toBe(1);
    expect(await balance(page)).toBe(price('light', 2) - 1);
  });
});
