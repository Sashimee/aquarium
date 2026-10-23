import { describe, expect, it } from 'vitest';
import { colonyCapacity } from '@aquarium/sim/lifecycle';
import { MAX_EQUIPMENT_TIER } from '@aquarium/shared';
import { loadChemistryParameters } from './chemistry.ts';
import { loadEconomy } from './economy.ts';

const prices = loadEconomy().items.equipment;
const params = loadChemistryParameters();
const tables = params.equipment;

const rateTables = {
  light: [tables.light.algaeGrowthPerTier],
  co2: [tables.co2.phDropPerTier, tables.co2.algaeFactorPerTier],
  waveMaker: [tables.waveMaker.algaeFactorPerTier],
} as const;

describe('equipment price lists against the chemistry rate tables', () => {
  it.each(Object.entries(rateTables))(
    'gives every sellable %s tier its own rate, and none beyond the best one',
    (device, perDevice) => {
      const sellable = prices[device as keyof typeof rateTables].length;
      for (const table of perDevice) {
        expect(table.length, `${device} table`).toBeGreaterThanOrEqual(sellable + 1);
        for (let tier = 1; tier <= sellable; tier++) {
          expect(table[tier], `${device} tier ${tier}`).not.toBe(table[tier - 1]);
        }
        for (let tier = sellable + 1; tier < table.length; tier++) {
          expect(table[tier], `${device} tier ${tier} is not for sale`).toBe(table[sellable]);
        }
      }
    },
  );

  it('sells heater and filter tiers up to the best one the schema allows', () => {
    expect(prices.heater).toHaveLength(MAX_EQUIPMENT_TIER);
    expect(prices.filter).toHaveLength(MAX_EQUIPMENT_TIER);
  });

  it('gives every sellable filter tier a larger colony than the one below, up to full', () => {
    const capacity = (tier: number) =>
      colonyCapacity(tier, params.bacteria.mediaCapacityPerFilterTier);
    for (let tier = 1; tier <= prices.filter.length; tier++) {
      expect(capacity(tier), `filter tier ${tier}`).toBeGreaterThan(capacity(tier - 1));
    }
    expect(capacity(prices.filter.length)).toBe(1);
  });
});
