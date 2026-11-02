import { expect, test } from '@playwright/test';
import { registerVerifiedUser } from '../support/app.ts';
import { addFish, createTank, errorOf, key, patchTank, purchase } from '../support/api.ts';
import {
  advanceDaysAndRead,
  feedIfPossible,
  fragRaw,
  readTank,
  trimRaw,
  type LifeCoral,
  type LifePlant,
  type LifeTank,
} from '../support/life.ts';

const plantOf = (tank: LifeTank, plantKey: string): LifePlant => {
  const plant = tank.plants?.find((p) => p.key === plantKey);
  if (!plant) throw new Error(`plant ${plantKey} is not in the tank`);
  return plant;
};

const coralOf = (tank: LifeTank, coralKey: string): LifeCoral => {
  const coral = tank.corals?.find((c) => c.key === coralKey);
  if (!coral) throw new Error(`coral ${coralKey} is not in the tank`);
  return coral;
};

test('plants grow while you are away, and a trim cuts one back for good', async ({ page }) => {
  await registerVerifiedUser(page, 'trim');
  const pond = await createTank(page, { name: 'Pond' });
  const start = await readTank(page, pond.id);
  expect(start.plants?.length, 'the preset freshwater layout has plants').toBeGreaterThan(0);

  await addFish(page, pond.id, 'neon-tetra', { name: 'Fertiliser 1' });
  await addFish(page, pond.id, 'neon-tetra', { name: 'Fertiliser 2' });
  await addFish(page, pond.id, 'neon-tetra', { name: 'Fertiliser 3' });
  let grown = start;
  for (let week = 0; week < 8; week += 1) {
    await feedIfPossible(page, pond.id);
    grown = await advanceDaysAndRead(page, pond.id, 5);
  }
  const target = (grown.plants ?? []).find((p) => p.size > plantOf(start, p.key).size);
  if (!target) throw new Error('no plant grew in 40 days with fish making nitrate');

  const middle = (target.size + target.minSize) / 2;
  const firstKey = key();
  const trimmed = await trimRaw(page, pond.id, target.key, middle, firstKey);
  expect(trimmed.status(), await trimmed.text()).toBe(200);
  const afterFirst = plantOf((await trimmed.json()) as LifeTank, target.key);
  expect(afterFirst.size).toBeLessThan(target.size);
  expect(afterFirst.size).toBeGreaterThanOrEqual(middle - 0.01);

  const replay = await trimRaw(page, pond.id, target.key, middle, firstKey);
  expect(replay.status(), 'the same key replays instead of cutting twice').toBe(200);
  expect(plantOf((await replay.json()) as LifeTank, target.key).size).toBeCloseTo(
    afterFirst.size,
    2,
  );

  const reused = await trimRaw(page, pond.id, target.key, target.minSize, firstKey);
  expect(reused.status()).toBe(409);
  expect((await errorOf(reused)).reason).toBe('key_reused');

  const toFloor = await trimRaw(page, pond.id, target.key, target.minSize);
  expect(toFloor.status()).toBe(200);
  expect(plantOf((await toFloor.json()) as LifeTank, target.key).size).toBeCloseTo(
    target.minSize,
    2,
  );

  const alreadySmall = await trimRaw(page, pond.id, target.key, target.minSize);
  expect(alreadySmall.status()).toBe(409);
  expect((await errorOf(alreadySmall)).reason).toBe('plant_not_grown');

  const belowFloor = await trimRaw(page, pond.id, target.key, target.minSize / 2);
  expect(belowFloor.status(), 'a plant cannot be cut below its species floor').toBe(400);

  const unknown = await trimRaw(page, pond.id, 'no-such-plant', 0.5);
  expect(unknown.status()).toBe(404);
});

test('a reef colony grows in good light, bleaches in too much, and is fragged once healthy', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await registerVerifiedUser(page, 'frag');
  const reef = await createTank(page, { name: 'Reef', biome: 'reef' });
  const start = await readTank(page, reef.id);
  const layout = start.corals ?? [];
  expect(layout.length, 'the preset reef layout has corals').toBeGreaterThan(0);
  const colony = layout[0] as LifeCoral;

  const tooSoon = await fragRaw(page, reef.id, colony.key);
  expect(tooSoon.status()).toBe(409);
  expect((await errorOf(tooSoon)).reason).toBe('coral_not_grown');
  const unknown = await fragRaw(page, reef.id, 'no-such-coral');
  expect(unknown.status()).toBe(404);

  if (start.equipment.light.tier < 2) {
    const bought = await purchase(page, 'equipment:light:2', { tankId: reef.id });
    expect(bought.status(), await bought.text()).toBe(200);
  }
  const bright = await patchTank(page, reef.id, {
    light: { intensity: 1, onHour: 8, offHour: 20 },
  });
  expect(bright.ok(), await bright.text()).toBe(true);

  await advanceDaysAndRead(page, reef.id, 55);
  const grown = coralOf(await advanceDaysAndRead(page, reef.id, 55), colony.key);
  expect(grown.size).toBeGreaterThan(colony.size);
  expect(grown.size, 'grown past the size a fragment can be cut at').toBeGreaterThanOrEqual(
    grown.fragMinSize,
  );
  expect(grown.bleach).toBeLessThan(0.1);

  const glare = await purchase(page, 'equipment:light:3', { tankId: reef.id });
  expect(glare.status(), await glare.text()).toBe(200);
  const patched = await patchTank(page, reef.id, {
    light: { intensity: 1, onHour: 8, offHour: 20 },
  });
  expect(patched.ok(), await patched.text()).toBe(true);
  const bleached = coralOf(await advanceDaysAndRead(page, reef.id, 5), colony.key);
  expect(bleached.bleach, 'too much light bleaches the colony').toBeGreaterThan(0.9);

  const refused = await fragRaw(page, reef.id, colony.key);
  expect(refused.status()).toBe(409);
  expect((await errorOf(refused)).reason).toBe('coral_bleached');

  const dimmed = await patchTank(page, reef.id, {
    light: { intensity: 0.5, onHour: 8, offHour: 20 },
  });
  expect(dimmed.ok(), await dimmed.text()).toBe(true);
  const recovered = coralOf(await advanceDaysAndRead(page, reef.id, 55), colony.key);
  expect(recovered.bleach).toBeLessThan(0.3);
  expect(recovered.size).toBeGreaterThanOrEqual(recovered.fragMinSize);

  const idempotencyKey = key();
  const cut = await fragRaw(page, reef.id, colony.key, idempotencyKey);
  expect(cut.status(), await cut.text()).toBe(200);
  const after = (await cut.json()) as LifeTank;
  const fragment = (after.corals ?? []).find((c) => c.parentKey === colony.key);
  expect(fragment, 'the cut put a fragment into the tank').toBeDefined();
  expect(fragment?.bleach).toBe(0);
  expect(coralOf(after, colony.key).size).toBeLessThan(recovered.size);

  const replay = await fragRaw(page, reef.id, colony.key, idempotencyKey);
  expect(replay.status()).toBe(200);
  expect(
    ((await replay.json()) as LifeTank).corals?.filter((c) => c.parentKey === colony.key),
  ).toHaveLength(1);
  const elsewhere = layout[1];
  if (elsewhere) {
    const reused = await fragRaw(page, reef.id, elsewhere.key, idempotencyKey);
    expect(reused.status()).toBe(409);
    expect((await errorOf(reused)).reason).toBe('key_reused');
  }
});
