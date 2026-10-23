import { tankSizeSchema } from '@aquarium/shared';
import { maxFishLengthM } from '@aquarium/sim';
import { describe, expect, it } from 'vitest';
import { TANK_DIMENSIONS } from '../engine/tank/dimensions';
import { tankSpaceOf } from '../fish/demoStock';
import { tankMaxFishLengthM } from './fishFit';

describe('tankMaxFishLengthM', () => {
  it.each(tankSizeSchema.options)('matches the sim limit for %s, rounded down', (size) => {
    const exact = maxFishLengthM(tankSpaceOf(TANK_DIMENSIONS[size]));
    expect(tankMaxFishLengthM(size)).toBeLessThanOrEqual(exact);
    expect(exact - tankMaxFishLengthM(size)).toBeLessThan(1e-4);
  });
});
