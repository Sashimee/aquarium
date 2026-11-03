import { expect, test } from '@playwright/test';
import { dockButton, openDock, openTank, registerVerifiedUser } from '../support/app.ts';
import { createTank } from '../support/api.ts';
import { advanceDays, readTank } from '../support/life.ts';

const ROOM_C = 21;

const waterC = async (page: Parameters<typeof readTank>[0], tankId: string): Promise<number> => {
  const tank = (await readTank(page, tankId)) as unknown as { chemistry: { temperatureC: number } };
  return tank.chemistry.temperatureC;
};

test.describe('removing and reinstalling the heater', () => {
  test('remove asks first, the water cools, the shop shows it as owned, reinstall is free', async ({
    page,
  }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'heater');
    const pond = await createTank(page, { name: 'Pond' });
    const warmSpecies = (await (await page.request.get('/api/species')).json()) as {
      commonName: string;
      warmWater: boolean;
      biome: string;
    }[];
    const warm = warmSpecies.find((s) => s.warmWater && s.biome === pond.biome);
    expect(warm, 'a warm-water species for this biome').toBeDefined();

    await openTank(page);
    const care = await openDock(page, 'Care', 'Care');
    const heater = care.getByRole('region', { name: 'Heater' });
    await expect(heater.getByRole('button', { name: /Reinstall heater/ })).toHaveCount(0);

    await heater.getByRole('button', { name: 'Remove heater' }).click();
    await expect(heater).toContainText('cools to room temperature');
    expect((await readTank(page, pond.id)).equipment.heater.tier).toBe(1);

    await heater.getByRole('button', { name: 'Remove heater' }).click();
    await expect(heater.getByRole('button', { name: 'Reinstall heater (free)' })).toBeVisible();
    const removed = await readTank(page, pond.id);
    expect(removed.equipment.heater.tier).toBe(0);
    expect(removed.heaterOwnedTier).toBe(1);

    await advanceDays(page, 3);
    expect(await waterC(page, pond.id)).toBeLessThan(ROOM_C + 1);

    const shop = await openDock(page, 'Shop', 'Fish shop');
    const heaterRow = shop
      .getByRole('region', { name: 'Equipment' })
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'Heater', exact: true }) })
      .first();
    await expect(
      heaterRow.getByRole('button', { name: 'Heater tier 1 is already owned' }),
    ).toBeDisabled();
    await expect(heaterRow).toContainText('You already own this tier');

    await shop
      .getByRole('listitem')
      .filter({ hasText: warm?.commonName ?? '' })
      .first()
      .getByRole('button', { name: 'Add', exact: true })
      .click();
    await expect(shop.locator('.warning')).toContainText('has no heater');

    await dockButton(page, 'Shop').click();
    const careAgain = await openDock(page, 'Care', 'Care');
    await careAgain.getByRole('button', { name: 'Reinstall heater (free)' }).click();
    await expect(careAgain.getByRole('button', { name: 'Remove heater' })).toBeVisible();
    const back = await readTank(page, pond.id);
    expect(back.equipment.heater.tier).toBe(1);
    expect(back.heaterOwnedTier).toBe(1);
  });
});
