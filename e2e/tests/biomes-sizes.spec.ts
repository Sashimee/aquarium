import { expect, test } from '@playwright/test';
import { awaitLoaded, openTank, openTankPanel, registerVerifiedUser } from '../support/app.ts';
import {
  addFish,
  addFishRaw,
  createTank,
  createTankRaw,
  errorOf,
  key,
  wallet,
  type Biome,
  type Size,
} from '../support/api.ts';
import { tankCost } from '../support/economy.ts';

const PLAN: { biome: Biome; size: Size; species: string }[] = [
  { biome: 'freshwater', size: 'standard', species: 'neon-tetra' },
  { biome: 'reef', size: 'nano30', species: 'hermit-crab' },
  { biome: 'cichlid', size: 'std200', species: 'labidochromis-caeruleus' },
  { biome: 'blackwater', size: 'long300', species: 'cardinal-tetra' },
  { biome: 'mangrove', size: 'standard', species: 'bumblebee-goby' },
  { biome: 'freshwater', size: 'nano30', species: 'cherry-shrimp' },
];

test('every biome and size is created, charged by slot and size, and stocked with its own species', async ({
  page,
}) => {
  await registerVerifiedUser(page, 'sizes');

  for (const [index, { biome, size, species }] of PLAN.entries()) {
    const tank = await createTank(page, { name: `Tank ${index + 1}`, biome, size });
    expect(tank).toMatchObject({ biome, size, quarantine: false });

    const cost = tankCost(index, size);
    const bought = (await wallet(page)).ledger.find((row) =>
      row.itemRef?.startsWith(`tank:${size}:${tank.id}`),
    );
    if (cost === 0) expect(bought, `${size} tank number ${index + 1} is free`).toBeUndefined();
    else expect(bought?.delta, `${size} tank number ${index + 1}`).toBe(-cost);

    const stocked = await addFish(page, tank.id, species);
    expect(stocked.fish.map((f) => f.species)).toEqual([species]);
  }
});

test('a species from another biome, or one that needs a longer tank, is refused and not charged', async ({
  page,
}) => {
  await registerVerifiedUser(page, 'wrongbiome');
  const reef = await createTank(page, { biome: 'reef' });

  const wrongBiome = await addFishRaw(page, reef.id, 'neon-tetra');
  expect(wrongBiome.status()).toBe(400);
  expect((await errorOf(wrongBiome)).message).toContain('freshwater');

  const mangrove = await createTank(page, { name: 'Mangrove', biome: 'mangrove' });
  const tooShort = await addFishRaw(page, mangrove.id, 'silver-mono');
  expect(tooShort.status()).toBe(400);
  expect((await errorOf(tooShort)).message).toContain('at least 150 cm long');

  const bought = (await wallet(page)).ledger.filter((row) => row.itemRef?.startsWith('species:'));
  expect(bought).toEqual([]);
});

test('six display tanks at most, one nano quarantine tank on top, and a retried create makes one tank', async ({
  page,
}) => {
  await registerVerifiedUser(page, 'limits');

  const retried = key();
  const first = await createTank(page, { name: 'First', idempotencyKey: retried });
  for (let n = 2; n <= 6; n += 1) await createTank(page, { name: `Tank ${n}` });

  const replay = await createTankRaw(page, { name: 'First', idempotencyKey: retried });
  expect(replay.status()).toBe(200);
  expect(((await replay.json()) as { id: string }).id).toBe(first.id);

  const seventh = await createTankRaw(page, { name: 'Seventh' });
  expect(seventh.status()).toBe(409);
  expect((await errorOf(seventh)).message).toContain('at most 6 display tanks');

  const bigQuarantine = await createTankRaw(page, { name: 'Sick bay', quarantine: true });
  expect(bigQuarantine.status(), 'a quarantine tank is always nano').toBe(400);

  const spent = (await wallet(page)).wallet.balance;
  const sickBay = await createTankRaw(page, { name: 'Sick bay', quarantine: true, size: 'nano30' });
  expect(sickBay.status()).toBe(201);
  expect(await sickBay.json()).toMatchObject({ quarantine: true, size: 'nano30' });
  expect((await wallet(page)).wallet.balance, 'a quarantine tank is free').toBe(spent);

  const second = await createTankRaw(page, {
    name: 'Second bay',
    quarantine: true,
    size: 'nano30',
  });
  expect(second.status()).toBe(409);
  expect((await errorOf(second)).message).toContain('quarantine tank');

  const tanks = (await (await page.request.get('/api/tanks')).json()) as unknown[];
  expect(tanks).toHaveLength(7);
});

test('the new-tank form offers every biome and size with its price and creates a nano tank', async ({
  page,
}) => {
  test.setTimeout(420_000);
  await registerVerifiedUser(page, 'sizeform');
  await createTank(page, { name: 'Home' });
  await openTank(page);

  const panel = await openTankPanel(page);
  await panel.getByRole('button', { name: 'New tank' }).click();
  const kinds = panel.getByLabel('Kind of tank');
  await expect(kinds.getByRole('option')).toHaveCount(5);
  const sizes = panel.getByLabel('Size', { exact: true });
  await expect(sizes.getByRole('option')).toHaveCount(4);
  await expect(sizes.getByRole('option', { name: /^Nano, 30 L.*up to 12 animals/ })).toHaveCount(1);

  await kinds.selectOption('reef');
  await sizes.selectOption('nano30');
  const price = tankCost(1, 'nano30');
  await expect(panel.getByText(/Price of this tank:/)).toContainText(
    `${price.toLocaleString('en')} Pearls`,
  );
  await panel.getByLabel('Tank name').fill('Reef nano');
  await panel.getByRole('button', { name: 'Create tank' }).click();
  await panel.getByRole('button', { name: 'Yes, buy it' }).click();

  await expect(panel.getByLabel('Active tank')).toContainText('Reef nano (Reef, Nano 30 L)', {
    timeout: 60_000,
  });
  await awaitLoaded(page);
  await expect(page.locator('#app')).toHaveAttribute('data-scene-biome', 'reef');
});
