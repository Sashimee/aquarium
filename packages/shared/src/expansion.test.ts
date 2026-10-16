import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ESTABLISHED_TANK_CHEMISTRY,
  NEW_TANK_CHEMISTRY,
  chemistryParametersSchema,
  chemistrySchema,
} from './chemistry.js';
import { DEFAULT_EQUIPMENT, equipmentProblems, equipmentSchema } from './equipment.js';
import {
  NEUTRAL_PERSONALITY,
  diseaseStateSchema,
  fishStageSchema,
  personalitySchema,
} from './fishState.js';
import { breedingSchema, speciesChemistrySchema, speciesSummarySchema } from './species.js';

const content = join(import.meta.dirname, '../../../content');
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(content, path), 'utf8'));

describe('chemistry v2', () => {
  it('content/chemistry.json passes the strict schema', () => {
    expect(chemistryParametersSchema.safeParse(readJson('chemistry.json')).error).toBeUndefined();
  });

  it('rejects an unknown rate and a missing biome target', () => {
    const raw = readJson('chemistry.json') as Record<string, Record<string, unknown>>;
    expect(
      chemistryParametersSchema.safeParse({ ...raw, nitrite: { ...raw['nitrite'], typo: 1 } })
        .success,
    ).toBe(false);
    expect(
      chemistryParametersSchema.safeParse({
        ...raw,
        ph: { ...raw['ph'], target: { freshwater: 7 } },
      }).success,
    ).toBe(false);
  });

  it('starts a new tank uncycled and keeps older tanks established', () => {
    expect(chemistrySchema.parse(NEW_TANK_CHEMISTRY).bacteria).toEqual({
      ammoniaOxidisers: 0,
      nitriteOxidisers: 0,
    });
    expect(chemistrySchema.parse(ESTABLISHED_TANK_CHEMISTRY).bacteria.nitriteOxidisers).toBe(1);
  });

  it('bounds the readings', () => {
    expect(chemistrySchema.safeParse({ ...NEW_TANK_CHEMISTRY, ph: 15 }).success).toBe(false);
    expect(chemistrySchema.safeParse({ ...NEW_TANK_CHEMISTRY, nitrite: -1 }).success).toBe(false);
    expect(
      chemistrySchema.safeParse({
        ...NEW_TANK_CHEMISTRY,
        bacteria: { ammoniaOxidisers: 2, nitriteOxidisers: 0 },
      }).success,
    ).toBe(false);
  });
});

describe('species additions', () => {
  const files = readdirSync(join(content, 'species')).filter((f) => f.endsWith('.json'));

  it.each(files)('%s gets non-breeding defaults without edits', (file) => {
    const parsed = speciesSummarySchema.loose().parse(readJson(`species/${file}`));
    expect(parsed.breeding.mode).toBe('none');
    expect(parsed.chemistry.phRange[0]).toBeLessThan(parsed.chemistry.phRange[1]);
  });

  const livebearer = {
    mode: 'livebearer',
    minAgeDays: 90,
    intervalDays: 30,
    broodSize: [4, 12],
    fryGrowth: { juvenileAfterDays: 14, adultAfterDays: 70 },
  };

  it('accepts a complete breeder', () => {
    expect(breedingSchema.parse(livebearer).needsPair).toBe(true);
  });

  it('rejects a breeder missing its brood or growth block', () => {
    expect(breedingSchema.safeParse({ mode: 'mouthbrooder' }).success).toBe(false);
    expect(breedingSchema.safeParse({ ...livebearer, fryGrowth: undefined }).success).toBe(false);
  });

  it('rejects inverted ranges and fry stages', () => {
    expect(breedingSchema.safeParse({ ...livebearer, broodSize: [12, 4] }).success).toBe(false);
    expect(
      breedingSchema.safeParse({
        ...livebearer,
        fryGrowth: { juvenileAfterDays: 70, adultAfterDays: 14 },
      }).success,
    ).toBe(false);
    expect(speciesChemistrySchema.safeParse({ phRange: [8, 6] }).success).toBe(false);
    expect(speciesChemistrySchema.safeParse({ temperatureC: [30, 20] }).success).toBe(false);
  });

  it('rejects an unknown breeding mode', () => {
    expect(breedingSchema.safeParse({ mode: 'budding' }).success).toBe(false);
  });
});

describe('fish state', () => {
  it('knows three stages', () => {
    expect(fishStageSchema.options).toEqual(['fry', 'juvenile', 'adult']);
  });

  it('bounds personality traits to 0..1', () => {
    expect(personalitySchema.parse(NEUTRAL_PERSONALITY)).toEqual(NEUTRAL_PERSONALITY);
    expect(personalitySchema.safeParse({ ...NEUTRAL_PERSONALITY, greed: 1.2 }).success).toBe(false);
    expect(personalitySchema.safeParse({ boldness: 0.5, greed: 0.5 }).success).toBe(false);
  });

  it('validates a disease state', () => {
    const ich = {
      kind: 'ich',
      since: '2026-10-16T10:00:00.000Z',
      severity: 0.3,
      treatedUntil: null,
    };
    expect(diseaseStateSchema.safeParse(ich).success).toBe(true);
    expect(diseaseStateSchema.safeParse({ ...ich, kind: 'plague' }).success).toBe(false);
    expect(diseaseStateSchema.safeParse({ ...ich, severity: 2 }).success).toBe(false);
  });
});

describe('equipment', () => {
  it('has valid defaults that fit both biomes', () => {
    expect(equipmentSchema.parse(DEFAULT_EQUIPMENT)).toEqual(DEFAULT_EQUIPMENT);
    expect(equipmentProblems('freshwater', DEFAULT_EQUIPMENT)).toEqual([]);
    expect(equipmentProblems('reef', DEFAULT_EQUIPMENT)).toEqual([]);
  });

  it('bounds tiers and hours', () => {
    expect(equipmentSchema.safeParse({ ...DEFAULT_EQUIPMENT, filter: { tier: 4 } }).success).toBe(
      false,
    );
    expect(
      equipmentSchema.safeParse({
        ...DEFAULT_EQUIPMENT,
        light: { ...DEFAULT_EQUIPMENT.light, onHour: 24 },
      }).success,
    ).toBe(false);
  });

  it('keeps CO2 off reefs and wave makers off freshwater', () => {
    expect(equipmentProblems('reef', { ...DEFAULT_EQUIPMENT, co2: { tier: 1 } })).toHaveLength(1);
    expect(
      equipmentProblems('freshwater', { ...DEFAULT_EQUIPMENT, waveMaker: { tier: 2 } }),
    ).toHaveLength(1);
    expect(equipmentProblems('freshwater', { ...DEFAULT_EQUIPMENT, co2: { tier: 2 } })).toEqual([]);
  });
});
