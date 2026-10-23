import { maxFishLengthM } from '@aquarium/sim';
import { describe, expect, it } from 'vitest';
import { TANK_DIMENSIONS } from '../engine/tank/dimensions';
import { tankSpaceOf } from '../fish/demoStock';
import { tankMaxFishLengthM } from './fishFit';
import { TANK_SIZE_ORDER } from './life';

describe('tankMaxFishLengthM', () => {
  it.each(TANK_SIZE_ORDER)('matches the sim limit for %s, rounded down', (size) => {
    const exact = maxFishLengthM(tankSpaceOf(TANK_DIMENSIONS[size]));
    expect(tankMaxFishLengthM(size)).toBeLessThanOrEqual(exact);
    expect(exact - tankMaxFishLengthM(size)).toBeLessThan(1e-4);
  });
});
