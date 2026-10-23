import { describe, expect, it } from 'vitest';
import { MAX_EQUIPMENT_TIER, tankSizeSchema } from '@aquarium/shared';
import { World } from '@aquarium/sim';
import { TANK_DIMENSIONS } from '../engine/tank/dimensions';
import { CurrentField } from '../scene/current';
import { demoTank } from '../fish/demoStock';
import { pumpFieldFor } from './pumpField';

describe.each(tankSizeSchema.options)('pumpFieldFor on a %s tank', (size) => {
  const tank = TANK_DIMENSIONS[size];

  it('is the same water as the field in a world built the way the worker builds it', () => {
    const world = new World({ ...demoTank(tank, 1, 'reef').config, fish: [] });
    for (const tier of [1, 2, 3]) {
      const mine = pumpFieldFor(tier, tank);
      expect(mine).not.toBeNull();
      if (mine === null) continue;
      world.setWaveMaker(mine.settings);
      const theirs = world.flowField;
      expect(theirs).not.toBeNull();
      const { minX, maxX, minZ, maxZ, minY, maxY } = world.basin;
      const a = new Float64Array(3);
      const b = new Float64Array(3);
      for (const t of [0, 2.5, 7, 19]) {
        for (const fx of [-0.2, 0, 0.3, 0.5, 0.8, 1.2]) {
          for (const fy of [0, 0.4, 1]) {
            const x = minX + (maxX - minX) * fx;
            const y = minY + (maxY - minY) * fy;
            const z = minZ + (maxZ - minZ) * 0.37;
            mine.sample(x, y, z, t, a);
            theirs?.sample(x, y, z, t, b);
            expect([...a]).toEqual([...b]);
          }
        }
      }
    }
  });

  it('is null without a pump', () => {
    expect(pumpFieldFor(0, tank)).toBeNull();
  });
});

describe('pumpFieldFor for every tier', () => {
  it('gives each tier a field a real CurrentField accepts, a zero-speed one as no pump', () => {
    const current = new CurrentField();
    for (let tier = 0; tier <= MAX_EQUIPMENT_TIER; tier++) {
      const field = pumpFieldFor(tier, TANK_DIMENSIONS.standard);
      expect(() => current.setWaveMaker(field, 0)).not.toThrow();
    }
  });
});
