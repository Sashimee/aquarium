import { describe, expect, it } from 'vitest';
import { SAND_BED, WATER_INSET, sandHeight, tankSpaceOfSize } from './sizeSpace.js';
import { TANK_SIZES, tankSizeSchema } from './tankSize.js';
import { tankWaterBounds } from './tankSpace.js';

const tank = { depth: 0.5, glass: 0.01 };
const inner = tank.depth - 2 * tank.glass;
const FRONT = 0.04;
const BACK = 0.1;
const DUNE_MAX = 0.004 + 0.003 + 0.0015;

const flat = (x: number, z: number) => sandHeight(tank, FRONT, FRONT, x, z);
const sloped = (x: number, z: number) => sandHeight(tank, FRONT, BACK, x, z);

describe('sandHeight', () => {
  it('rises from the front glass to the back glass by the bed depths', () => {
    expect(sloped(0, inner / 2) - flat(0, inner / 2)).toBeCloseTo(0, 12);
    expect(sloped(0, -inner / 2) - flat(0, -inner / 2)).toBeCloseTo(BACK - FRONT, 12);
    expect(sloped(0.2, 0) - flat(0.2, 0)).toBeCloseTo((BACK - FRONT) / 2, 12);
  });

  it('sits the flat bed at the glass top plus its depth, within the dunes', () => {
    for (const [x, z] of [
      [0, 0],
      [0.3, 0.1],
      [-0.4, -0.15],
    ] as const) {
      expect(Math.abs(flat(x, z) - (tank.glass + FRONT))).toBeLessThanOrEqual(DUNE_MAX);
    }
    expect(flat(0, 0)).toBeCloseTo(tank.glass + FRONT, 12);
  });

  it('adds the three dunes as sines of x and z', () => {
    const x = 0.3;
    const z = 0.07;
    const dunes =
      0.004 * Math.sin(x * 21 + z * 6) +
      0.003 * Math.sin(-x * 9.5 + z * 29) +
      0.0015 * Math.sin(x * 47 - z * 13);
    expect(flat(x, z) - (tank.glass + FRONT)).toBeCloseTo(dunes, 12);
    expect(dunes).not.toBe(0);
  });

  it('holds the slope at its end values at and beyond the glass', () => {
    expect(sloped(0.1, inner / 2 + 1) - flat(0.1, inner / 2 + 1)).toBe(0);
    expect(sloped(0.1, -inner / 2 - 1) - flat(0.1, -inner / 2 - 1)).toBeCloseTo(BACK - FRONT, 12);
  });
});

describe('tankSpaceOfSize', () => {
  it.each(tankSizeSchema.options)('builds the %s floor from its sand bed', (size) => {
    const { glass } = TANK_SIZES[size].dimensions;
    const { front, back } = SAND_BED[size];
    const space = tankSpaceOfSize(size);
    expect(space.inset).toBe(WATER_INSET);
    expect(space.floor.min).toBeGreaterThanOrEqual(glass + front - DUNE_MAX);
    expect(space.floor.max).toBeLessThanOrEqual(glass + back + DUNE_MAX);
    const bounds = tankWaterBounds(space);
    expect(bounds.min[0]).toBeCloseTo(
      -TANK_SIZES[size].dimensions.length / 2 + glass + WATER_INSET,
      12,
    );
  });
});
