import { expect, test } from '@playwright/test';
import {
  advanceServerClock,
  openDock,
  openTank,
  registerVerifiedUser,
  returnToTab,
  savedTanks,
} from '../support/app.ts';
import { addFish, createTank, errorOf, wallet } from '../support/api.ts';
import {
  advanceDaysAndRead,
  feedIfPossible,
  moveRaw,
  readTank,
  treatRaw,
  waterChange,
  type LifeTank,
} from '../support/life.ts';

const SIX_HOURS = 6 * 60;

const trait = (value: number, words: [string, string, string]): string =>
  value < 1 / 3 ? words[0] : value < 2 / 3 ? words[1] : words[2];

async function breedUntilFry(
  page: Parameters<typeof feedIfPossible>[0],
  tankId: string,
  withWaterChanges = false,
): Promise<LifeTank | null> {
  for (let round = 0; round < 40; round += 1) {
    await feedIfPossible(page, tankId);
    if (withWaterChanges) await waterChange(page, tankId);
    await advanceServerClock(page, SIX_HOURS);
    const read = await readTank(page, tankId);
    if (read.fish.some((f) => f.stage === 'fry')) return read;
  }
  return null;
}

test.describe('breeding', () => {
  test('a fed brood of adult guppies has fry, and the open page announces them', async ({
    page,
  }) => {
    test.setTimeout(480_000);
    await registerVerifiedUser(page, 'breed');
    const tank = await createTank(page, { name: 'Nursery' });
    for (let n = 1; n <= 6; n += 1)
      await addFish(page, tank.id, 'guppy', { stage: 'adult', name: `Guppy ${n}` });
    await openTank(page);
    await expect(page.locator('.birth-status span')).toHaveCount(0);

    const seen = await breedUntilFry(page, tank.id);
    expect(seen, 'six fed adult guppies had a brood within ten simulated days').not.toBeNull();
    const fry = seen?.fish.filter((f) => f.stage === 'fry') ?? [];
    expect(fry.length).toBeGreaterThanOrEqual(3);
    expect(fry.length).toBeLessThanOrEqual(8);
    expect(fry.every((f) => f.species === 'guppy' && f.status === 'alive')).toBe(true);
    expect(seen?.away?.births?.map((b) => b.fishId).sort()).toEqual(fry.map((f) => f.id).sort());

    await returnToTab(page, 12 * 60);
    const notice = page.locator('.birth-status');
    await expect(notice).toContainText(/fry (was|were) born/);
    await expect(notice.getByRole('button', { name: 'Show them' })).toBeVisible();
    await notice.getByRole('button', { name: 'Dismiss birth message' }).click();
    await expect(notice.getByRole('button', { name: 'Show them' })).toHaveCount(0);

    const again = await readTank(page, tank.id);
    expect(again.away?.births ?? [], 'a brood is reported once').toHaveLength(0);
    expect(again.fish.filter((f) => f.stage === 'fry')).toHaveLength(fry.length);
  });

  test('a tank at its cap gets no fry and keeps every animal it has', async ({ page }) => {
    test.setTimeout(480_000);
    await registerVerifiedUser(page, 'breedcap');
    const nano = await createTank(page, { name: 'Tiny', size: 'nano30' });
    for (let n = 1; n <= 11; n += 1)
      await addFish(page, nano.id, 'cherry-shrimp', { stage: 'adult', name: `Shrimp ${n}` });

    const firstBrood = await breedUntilFry(page, nano.id, true);
    expect(firstBrood, 'a nano tank below its cap still breeds').not.toBeNull();
    const alive = (tank: LifeTank) => tank.fish.filter((f) => f.status === 'alive');
    expect(alive(firstBrood as LifeTank).length).toBeLessThanOrEqual(12);

    let latest = firstBrood as LifeTank;
    for (let round = 0; round < 40; round += 1) {
      await feedIfPossible(page, nano.id);
      await waterChange(page, nano.id);
      await advanceServerClock(page, SIX_HOURS);
      latest = await readTank(page, nano.id);
      expect(alive(latest).length, `round ${round}: living animals`).toBeLessThanOrEqual(12);
    }
    const kept = new Set(latest.fish.map((f) => f.id));
    for (const fish of (firstBrood as LifeTank).fish)
      expect(kept.has(fish.id), `${fish.name} is still in the tank`).toBe(true);
  });
});

test.describe('personality', () => {
  test('the Care panel shows each fish its traits, matching what the server stored', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'traits');
    const tank = await createTank(page, { name: 'Characters' });
    const names = ['Ada', 'Bram', 'Cleo'];
    for (const name of names) await addFish(page, tank.id, 'neon-tetra', { name });
    const stored = await readTank(page, tank.id);

    await openTank(page);
    const care = await openDock(page, 'Care', 'Care');
    const cards = care.getByRole('region', { name: 'Your fish' }).locator('article.fish-card');
    await expect(cards).toHaveCount(names.length);

    for (const name of names) {
      const fish = stored.fish.find((f) => f.name === name);
      const personality = fish?.personality;
      if (!personality) throw new Error(`${name} came back without a personality`);
      const card = cards.filter({ has: page.getByRole('heading', { name, exact: true }) });
      await expect(card).toHaveCount(1);
      await expect(card.getByRole('meter', { name: `Boldness of ${name}` })).toHaveAttribute(
        'aria-valuetext',
        trait(personality.boldness, ['Shy', 'Steady', 'Bold']),
      );
      await expect(card.getByRole('meter', { name: `Appetite of ${name}` })).toHaveAttribute(
        'aria-valuetext',
        trait(personality.greed, ['Picky', 'Hearty', 'Greedy']),
      );
      await expect(card.getByRole('meter', { name: `Company of ${name}` })).toHaveAttribute(
        'aria-valuetext',
        trait(personality.sociability, ['Loner', 'Easygoing', 'Social']),
      );
      await expect(card).not.toContainText('Still getting to know');
    }
  });

  test('a fish keeps the same character on every read, and visits count by day', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'visits');
    const tank = await createTank(page, { name: 'Regular' });
    await addFish(page, tank.id, 'neon-tetra', { name: 'Ada' });

    const first = await readTank(page, tank.id);
    expect(first.fish[0]?.personality).not.toBeNull();
    const sameDay = await readTank(page, tank.id);
    expect(sameDay.recentVisitDays, 'a second visit on the same day adds nothing').toBe(
      first.recentVisitDays,
    );

    const nextDay = await advanceDaysAndRead(page, tank.id, 1);
    expect(nextDay.recentVisitDays).toBe(first.recentVisitDays + 1);
    expect(nextDay.fish[0]?.personality).toEqual(first.fish[0]?.personality);
    const dayAfter = await advanceDaysAndRead(page, tank.id, 1);
    expect(dayAfter.recentVisitDays).toBe(first.recentVisitDays + 2);
  });
});

test.describe('disease and quarantine', () => {
  test('there is nothing to treat in a healthy tank, and nothing is charged for trying', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'healthy');
    const tank = await createTank(page, { name: 'Clinic' });
    await addFish(page, tank.id, 'neon-tetra', { name: 'Ada' });
    const before = (await wallet(page)).ledger.length;

    const refused = await treatRaw(page, tank.id, 'ich');
    expect(refused.ok()).toBe(false);
    expect((await errorOf(refused)).reason).toBe('nothing_to_treat');
    expect((await wallet(page)).ledger).toHaveLength(before);

    await openTank(page);
    const care = await openDock(page, 'Care', 'Care');
    const medicine = care.getByRole('region', { name: 'Sickness and medicine' });
    await expect(medicine).toContainText('No fish in this tank look sick.');
  });

  test('the quarantine tank is set up in the Care panel, takes a fish and gives it back', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await registerVerifiedUser(page, 'quarantine');
    const display = await createTank(page, { name: 'Display' });
    await addFish(page, display.id, 'neon-tetra', { name: 'Patient' });
    await addFish(page, display.id, 'neon-tetra', { name: 'Bystander' });

    await openTank(page);
    const care = await openDock(page, 'Care', 'Care');
    const section = care.getByRole('region', { name: 'Quarantine tank' });
    await expect(section).toContainText('does not count toward your six tanks');
    await section.getByRole('button', { name: 'Set up the quarantine tank' }).click();
    await expect(section.getByRole('status')).toContainText(
      'You are looking at the quarantine tank.',
    );

    const tanks = await savedTanks(page);
    expect(tanks).toHaveLength(2);
    const listed = (await (await page.request.get('/api/tanks')).json()) as {
      id: string;
      quarantine: boolean;
      size: string;
    }[];
    const quarantine = listed.find((t) => t.quarantine);
    expect(quarantine?.size).toBe('nano30');
    const quarantineId = quarantine?.id ?? '';
    const patient = (await readTank(page, display.id)).fish.find((f) => f.name === 'Patient');

    const moved = await moveRaw(page, display.id, patient?.id ?? '', quarantineId);
    expect(moved.ok(), await moved.text()).toBe(true);
    expect((await readTank(page, display.id)).fish.map((f) => f.name)).toEqual(['Bystander']);
    const there = await readTank(page, quarantineId);
    expect(there.fish.map((f) => f.id)).toEqual([patient?.id]);

    const sameTank = await moveRaw(page, quarantineId, patient?.id ?? '', quarantineId);
    expect(sameTank.status()).toBe(400);

    await openTank(page);
    const panel = await openDock(page, 'Care', 'Care');
    const quarantineSection = panel.getByRole('region', { name: 'Quarantine tank' });
    const open = quarantineSection.getByRole('button', { name: 'Open Quarantine' });
    const here = quarantineSection.getByRole('status');
    await expect(open.or(here)).toBeVisible();
    if (await open.isVisible()) await open.click();
    await expect(quarantineSection.getByRole('status')).toContainText(
      'You are looking at the quarantine tank.',
    );
    await quarantineSection.getByRole('button', { name: 'Move Patient to Display' }).click();
    await expect
      .poll(async () => (await readTank(page, quarantineId)).fish.length, {
        message: 'the quarantine tank empties once the fish is moved back',
      })
      .toBe(0);
    expect((await readTank(page, display.id)).fish.map((f) => f.name).sort()).toEqual([
      'Bystander',
      'Patient',
    ]);
  });
});

test.describe('the clean-up crew', () => {
  test('eight snails keep algae down where a bare tank grows it', async ({ page }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'crew');
    const crewed = await createTank(page, { name: 'Crewed' });
    const bare = await createTank(page, { name: 'Bare' });
    for (let n = 1; n <= 8; n += 1)
      await addFish(page, crewed.id, 'nerite-snail', { name: `Snail ${n}` });
    await addFish(page, bare.id, 'neon-tetra', { name: 'Ada' });

    let crewedRead: LifeTank | null = null;
    let bareRead: LifeTank | null = null;
    for (let day = 0; day < 6; day += 1) {
      for (const id of [crewed.id, bare.id]) await feedIfPossible(page, id);
      await advanceServerClock(page, 24 * 60);
      crewedRead = await readTank(page, crewed.id);
      bareRead = await readTank(page, bare.id);
    }
    expect(bareRead?.water.algae, 'a bare, lit tank grows algae').toBeGreaterThan(0);
    expect(crewedRead?.water.algae).toBeLessThan(bareRead?.water.algae ?? 0);
    expect(crewedRead?.fish.filter((f) => f.status === 'alive')).toHaveLength(8);
  });
});
