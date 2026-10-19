import { describe, expect, it } from 'vitest';
import { BUNDLED_CHEMISTRY, BUNDLED_ECONOMY } from './bundledEconomy';
import {
  chooseEquipment,
  deviceOffers,
  devicesForBiome,
  effectText,
  equipmentRef,
} from './equipment';
import { tankFixture } from './fixtures';

const economy = BUNDLED_ECONOMY;
const cp = BUNDLED_CHEMISTRY;

function withTiers(
  tiers: Partial<Record<'heater' | 'filter' | 'light' | 'co2' | 'waveMaker', number>>,
) {
  const base = tankFixture().equipment;
  return tankFixture({
    equipment: {
      heater: { tier: tiers.heater ?? base.heater.tier },
      filter: { tier: tiers.filter ?? base.filter.tier },
      light: { ...base.light, tier: tiers.light ?? base.light.tier },
      co2: { tier: tiers.co2 ?? base.co2.tier },
      waveMaker: { tier: tiers.waveMaker ?? base.waveMaker.tier },
    },
  });
}

describe('which devices a tank type sells', () => {
  it('sells CO2 to fresh water only and a wave maker to salt only', () => {
    expect(devicesForBiome('freshwater')).toEqual(['heater', 'filter', 'light', 'co2']);
    expect(devicesForBiome('reef')).toEqual(['heater', 'filter', 'light', 'waveMaker']);
  });

  it('follows the shared rule for the other biomes', () => {
    expect(devicesForBiome('cichlid')).toContain('co2');
    expect(devicesForBiome('blackwater')).not.toContain('waveMaker');
    expect(devicesForBiome('mangrove')).toContain('waveMaker');
    expect(devicesForBiome('mangrove')).not.toContain('co2');
  });
});

describe('deviceOffers', () => {
  it('shows the current tier, the price and an effect for each tier', () => {
    const offers = deviceOffers(tankFixture(), economy, cp);
    const heater = offers.find((o) => o.device === 'heater');
    expect(heater?.currentTier).toBe(1);
    expect(heater?.tiers.map((t) => t.price)).toEqual([50, 150, 400]);
    expect(heater?.tiers.map((t) => t.state)).toEqual(['installed', 'available', 'available']);
    for (const offer of offers) {
      for (const tier of offer.tiers) expect(tier.effect.length).toBeGreaterThan(20);
    }
  });

  it('offers as many tiers as the economy prices, two for CO2 and a wave maker', () => {
    const fresh = deviceOffers(tankFixture(), economy, cp);
    expect(fresh.find((o) => o.device === 'co2')?.tiers).toHaveLength(2);
    const reef = deviceOffers(tankFixture({ biome: 'reef' }), economy, cp);
    expect(reef.find((o) => o.device === 'waveMaker')?.tiers).toHaveLength(2);
  });

  it('marks lower tiers as owned-better and counts the tiers a purchase skips', () => {
    const tank = withTiers({ filter: 2 });
    const filter = deviceOffers(tank, economy, cp).find((o) => o.device === 'filter');
    expect(filter?.tiers.map((t) => t.state)).toEqual([
      'better-installed',
      'installed',
      'available',
    ]);
    expect(filter?.tiers.map((t) => t.skipped)).toEqual([0, 0, 0]);
    const bare = withTiers({ heater: 0 });
    const heater = deviceOffers(bare, economy, cp).find((o) => o.device === 'heater');
    expect(heater?.tiers.map((t) => t.skipped)).toEqual([0, 1, 2]);
  });
});

describe('chooseEquipment', () => {
  it('accepts the next tier at its own price', () => {
    expect(chooseEquipment(tankFixture(), economy, 'filter', 2)).toEqual({
      ok: true,
      ref: 'equipment:filter:2',
      price: 250,
      skipped: 0,
    });
  });

  it('allows skipping a tier and charges only the chosen tier, never both', () => {
    const choice = chooseEquipment(tankFixture(), economy, 'light', 3);
    expect(choice).toEqual({ ok: true, ref: 'equipment:light:3', price: 800, skipped: 1 });
  });

  it('refuses a downgrade and the tier the tank already has', () => {
    const tank = withTiers({ light: 3 });
    const down = chooseEquipment(tank, economy, 'light', 1);
    expect(down.ok).toBe(false);
    expect(!down.ok && down.reason).toMatch(/downgrade/);
    const same = chooseEquipment(tank, economy, 'light', 3);
    expect(same.ok).toBe(false);
    expect(!same.ok && same.reason).toMatch(/already has/);
  });

  it('refuses a device the tank type does not use and a tier that does not exist', () => {
    const wave = chooseEquipment(tankFixture(), economy, 'waveMaker', 1);
    expect(wave.ok).toBe(false);
    const co2 = chooseEquipment(tankFixture({ biome: 'reef' }), economy, 'co2', 1);
    expect(co2.ok).toBe(false);
    const missing = chooseEquipment(tankFixture(), economy, 'co2', 3);
    expect(!missing.ok && missing.reason).toMatch(/no tier 3/);
  });

  it('builds the item ref the server parses', () => {
    expect(equipmentRef('waveMaker', 2)).toBe('equipment:waveMaker:2');
  });
});

describe('effect text', () => {
  it('says algae grows only while the lamp is on', () => {
    expect(effectText('light', 1, cp)).toMatch(/only while the lamp is on/);
    expect(effectText('light', 2, cp)).toMatch(/1\.4 times as fast as with tier 1/);
  });

  it('says CO2 lowers the pH, with the number the server uses', () => {
    expect(effectText('co2', 1, cp)).toMatch(/Lowers the pH by 0\.5/);
    expect(effectText('co2', 2, cp)).toMatch(/Lowers the pH by 1 /);
  });

  it('is honest that a stronger heater changes nothing the fish can feel', () => {
    expect(effectText('heater', 1, cp)).toContain('31');
    expect(effectText('heater', 3, cp)).toMatch(/adds headroom and nothing else/);
  });

  it('gives the filter media share of a full colony, capped at all of it', () => {
    expect(effectText('filter', 1, cp)).toContain('40%');
    expect(effectText('filter', 2, cp)).toContain('80%');
    expect(effectText('filter', 3, cp)).toContain('100%');
  });
});
