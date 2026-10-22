import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chemistryParametersSchema } from './chemistry.js';
import {
  DEFAULT_EQUIPMENT,
  MAX_EQUIPMENT_TIER,
  equipmentSchema,
  lightScheduleSchema,
} from './equipment.js';
import { isWarmWater, speciesChemistrySchema } from './species.js';
import { updateTankRequestSchema } from './tank.js';

describe('lamp schedule', () => {
  it('needs a night and valid hours and intensity', () => {
    const ok = { intensity: 0.5, onHour: 7, offHour: 19 };
    expect(lightScheduleSchema.safeParse(ok).success).toBe(true);
    expect(lightScheduleSchema.safeParse({ ...ok, offHour: 7 }).success).toBe(false);
    expect(lightScheduleSchema.safeParse({ ...ok, onHour: 24 }).success).toBe(false);
    expect(lightScheduleSchema.safeParse({ ...ok, intensity: -0.1 }).success).toBe(false);
    expect(lightScheduleSchema.safeParse({ ...ok, tier: 2 }).success).toBe(false);
  });

  it('is accepted alone by a tank update, which never carries a tier', () => {
    const light = { intensity: 1, onHour: 0, offHour: 12 };
    expect(updateTankRequestSchema.safeParse({ light }).success).toBe(true);
    expect(updateTankRequestSchema.safeParse({}).success).toBe(false);
    expect(equipmentSchema.parse(DEFAULT_EQUIPMENT)).toEqual(DEFAULT_EQUIPMENT);
  });
});

describe('co2 in a tank update', () => {
  it('takes a tier from off to the top, alone, and nothing else', () => {
    for (const tier of [0, 1, MAX_EQUIPMENT_TIER]) {
      expect(updateTankRequestSchema.safeParse({ co2: { tier } }).success, `${tier}`).toBe(true);
    }
    for (const co2 of [{ tier: -1 }, { tier: MAX_EQUIPMENT_TIER + 1 }, { tier: 1.5 }, {}]) {
      expect(updateTankRequestSchema.safeParse({ co2 }).success, JSON.stringify(co2)).toBe(false);
    }
  });
});

describe('content/chemistry.json equipment rates', () => {
  const params = chemistryParametersSchema.parse(
    JSON.parse(readFileSync(new URL('../../../content/chemistry.json', import.meta.url), 'utf8')),
  );

  it('covers every tier, with no device making things worse than none', () => {
    const { light, co2, waveMaker } = params.equipment;
    expect(light.algaeGrowthPerTier[0]).toBe(0);
    expect(light.algaeGrowthPerTier).toEqual([...light.algaeGrowthPerTier].sort((a, b) => a - b));
    expect(co2.algaeFactorPerTier[0]).toBe(1);
    expect(co2.phDropPerTier[0]).toBe(0);
    expect(waveMaker.algaeFactorPerTier[0]).toBe(1);
    for (const f of [...co2.algaeFactorPerTier, ...waveMaker.algaeFactorPerTier]) {
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it('rejects a table that misses a tier', () => {
    const broken = structuredClone(params);
    broken.equipment.co2.phDropPerTier = [0, 0.5];
    expect(chemistryParametersSchema.safeParse(broken).success).toBe(false);
  });
});

describe('isWarmWater', () => {
  it('is true only when the range starts above room temperature', () => {
    const range = (low: number, high: number) =>
      speciesChemistrySchema.parse({ temperatureC: [low, high] });
    expect(isWarmWater(range(26, 30), 21)).toBe(true);
    expect(isWarmWater(range(21, 26), 21)).toBe(false);
    expect(isWarmWater(range(18, 28), 21)).toBe(false);
  });
});
