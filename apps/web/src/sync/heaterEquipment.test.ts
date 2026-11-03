import { describe, expect, it } from 'vitest';
import { BUNDLED_CHEMISTRY, BUNDLED_ECONOMY } from './bundledEconomy';
import { chooseEquipment, deviceOffers } from './equipment';
import { tankFixture } from './fixtures';

function heaterTank(tier: number, owned: number) {
  const base = tankFixture();
  return { ...base, equipment: { ...base.equipment, heater: { tier } }, heaterOwnedTier: owned };
}

const states = (tank: ReturnType<typeof heaterTank>) =>
  deviceOffers(tank, BUNDLED_ECONOMY, BUNDLED_CHEMISTRY)
    .find((o) => o.device === 'heater')
    ?.tiers.map((t) => t.state);

describe('the shop with the heater removed', () => {
  it('shows tiers up to the owned one as owned and the rest as available', () => {
    expect(states(heaterTank(0, 1))?.slice(0, 2)).toEqual(['owned', 'available']);
    expect(states(heaterTank(0, 2))?.slice(0, 3)).toEqual(['owned', 'owned', 'available']);
  });

  it('refuses a re-buy at or below the owned tier and points to Care', () => {
    for (const tier of [1, 2]) {
      const choice = chooseEquipment(heaterTank(0, 2), BUNDLED_ECONOMY, 'heater', tier);
      expect(choice.ok).toBe(false);
      expect(!choice.ok && choice.reason).toContain('Care for free');
    }
  });

  it('sells a higher tier and counts skips from the owned tier', () => {
    expect(chooseEquipment(heaterTank(0, 1), BUNDLED_ECONOMY, 'heater', 2)).toMatchObject({
      ok: true,
      skipped: 0,
    });
  });

  it('keeps the better-installed rule while the heater is in', () => {
    expect(states(heaterTank(2, 2))?.slice(0, 2)).toEqual(['better-installed', 'installed']);
  });
});
