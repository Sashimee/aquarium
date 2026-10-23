import { describe, expect, it } from 'vitest';
import type { Biome, Tank } from '@aquarium/shared';
import { newTankChemistry } from '@aquarium/shared';
import { BUNDLED_CHEMISTRY, BUNDLED_ECONOMY } from './bundledEconomy';
import { doseOptions } from './doses';
import { tankFixture } from './fixtures';

function tankOf(biome: Biome, overrides: Partial<Tank> = {}): Tank {
  return tankFixture({ biome, chemistry: newTankChemistry(biome), ...overrides });
}

function types(tank: Tank): string[] {
  return doseOptions(tank, BUNDLED_CHEMISTRY, BUNDLED_ECONOMY).map((o) => o.type);
}

describe('doseOptions', () => {
  it.each([
    ['freshwater', ['buffer_dose', 'add_botanicals']],
    ['reef', ['salt_dose']],
    ['cichlid', ['buffer_dose']],
    ['blackwater', ['add_botanicals']],
    ['mangrove', ['salt_dose', 'buffer_dose']],
  ] as const)('%s offers only the doses it allows', (biome, expected) => {
    expect(types(tankOf(biome))).toEqual(expected);
  });

  it('prices the doses from the economy', () => {
    const options = doseOptions(tankOf('mangrove'), BUNDLED_CHEMISTRY, BUNDLED_ECONOMY);
    expect(options.map((o) => o.price)).toEqual([0, BUNDLED_ECONOMY.items.consumables.bufferDose]);
  });

  it('disables a buffer dose at the KH ceiling with a reason', () => {
    const base = tankOf('cichlid');
    const ceiling = BUNDLED_CHEMISTRY.kh.bufferCeiling.cichlid;
    const [atCeiling] = doseOptions(
      { ...base, chemistry: { ...base.chemistry, kh: ceiling } },
      BUNDLED_CHEMISTRY,
      BUNDLED_ECONOMY,
    );
    expect(atCeiling?.disabledReason).toMatch(/already as hard/);
    const [below] = doseOptions(
      { ...base, chemistry: { ...base.chemistry, kh: ceiling - 0.1 } },
      BUNDLED_CHEMISTRY,
      BUNDLED_ECONOMY,
    );
    expect(below?.disabledReason).toBeNull();
  });

  it('disables the salt dose at the mix level, as a new reef tank starts', () => {
    const reef = tankOf('reef');
    expect(reef.chemistry.salinity).toBe(BUNDLED_CHEMISTRY.salinity.target.reef);
    const [atMix] = doseOptions(reef, BUNDLED_CHEMISTRY, BUNDLED_ECONOMY);
    expect(atMix?.disabledReason).toMatch(/already as salty/);
  });

  it('disables the salt dose above the mix and enables it below', () => {
    const reef = tankOf('reef');
    const mix = BUNDLED_CHEMISTRY.salinity.target.reef;
    const at = (salinity: number) =>
      doseOptions(
        { ...reef, chemistry: { ...reef.chemistry, salinity } },
        BUNDLED_CHEMISTRY,
        BUNDLED_ECONOMY,
      )[0]?.disabledReason;
    expect(at(mix + 1)).toMatch(/already as salty/);
    expect(at(mix - 1)).toBeNull();
  });

  it('disables botanicals at the tannin ceiling with a reason', () => {
    const base = tankOf('blackwater');
    const ceiling = BUNDLED_CHEMISTRY.tannin.ceiling.blackwater;
    const [full] = doseOptions(
      { ...base, water: { ...base.water, tannin: ceiling } },
      BUNDLED_CHEMISTRY,
      BUNDLED_ECONOMY,
    );
    expect(full?.disabledReason).toMatch(/already as dark/);
    const [clear] = doseOptions(base, BUNDLED_CHEMISTRY, BUNDLED_ECONOMY);
    expect(clear?.disabledReason).toBeNull();
  });
});
