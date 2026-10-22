import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TANK_SIZE,
  MAX_DISPLAY_TANKS,
  MAX_QUARANTINE_TANKS,
  QUARANTINE_TANK_SIZE,
  TANK_SIZES,
  tankSizeSchema,
} from './tankSize.js';
import { createTankRequestSchema } from './tank.js';

describe('tank sizes', () => {
  it('has a spec for every size, and the default is today’s tank', () => {
    expect(Object.keys(TANK_SIZES).sort()).toEqual([...tankSizeSchema.options].sort());
    expect(DEFAULT_TANK_SIZE).toBe('standard');
    expect(TANK_SIZES.standard.dimensions).toMatchObject({ length: 1.2, depth: 0.5, height: 0.5 });
  });

  it('caps a nano at 12 animals and the others at 60', () => {
    expect(TANK_SIZES.nano30.maxAnimals).toBe(12);
    for (const size of ['standard', 'std200', 'long300'] as const) {
      expect(TANK_SIZES[size].maxAnimals).toBe(60);
    }
  });

  it('allows 6 display tanks plus one nano quarantine tank', () => {
    expect(MAX_DISPLAY_TANKS).toBe(6);
    expect(MAX_QUARANTINE_TANKS).toBe(1);
    expect(QUARANTINE_TANK_SIZE).toBe('nano30');
  });
});

describe('create tank request', () => {
  const base = { name: 'Home', biome: 'freshwater', idempotencyKey: 'abcdefgh1' };

  it('defaults to a standard display tank', () => {
    expect(createTankRequestSchema.parse(base)).toMatchObject({
      size: 'standard',
      quarantine: false,
    });
  });

  it('requires a quarantine tank to be nano', () => {
    expect(createTankRequestSchema.safeParse({ ...base, quarantine: true }).success).toBe(false);
    expect(
      createTankRequestSchema.safeParse({ ...base, quarantine: true, size: 'nano30' }).success,
    ).toBe(true);
  });

  it('requires an idempotency key', () => {
    expect(createTankRequestSchema.safeParse({ name: 'Home', biome: 'freshwater' }).success).toBe(
      false,
    );
  });

  it('accepts a brackish mangrove tank', () => {
    expect(createTankRequestSchema.parse({ ...base, biome: 'mangrove' }).biome).toBe('mangrove');
  });

  it('refuses biomes that have no preset yet and unknown sizes', () => {
    expect(createTankRequestSchema.safeParse({ ...base, biome: 'cichlid' }).success).toBe(false);
    expect(createTankRequestSchema.safeParse({ ...base, biome: 'blackwater' }).success).toBe(false);
    expect(createTankRequestSchema.safeParse({ ...base, size: 'huge' }).success).toBe(false);
  });
});
