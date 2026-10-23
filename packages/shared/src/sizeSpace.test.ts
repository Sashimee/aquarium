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

  it('eases the slope: a quarter of the way back it has risen 15.625% of the bed difference', () => {
    const rise = (z: number) => sloped(0.2, z) - flat(0.2, z);
    expect(rise(inner / 4)).toBeCloseTo((BACK - FRONT) * 0.15625, 12);
    expect(rise(-inner / 4)).toBeCloseTo((BACK - FRONT) * 0.84375, 12);
  });

  it('rises monotonically from front to back', () => {
    const steps = 40;
    let previous = -Infinity;
    for (let i = 0; i <= steps; i++) {
      const rise =
        sloped(0.2, inner / 2 - (inner * i) / steps) - flat(0.2, inner / 2 - (inner * i) / steps);
      expect(rise).toBeGreaterThanOrEqual(previous);
      previous = rise;
    }
  });

  it('adds dunes that stay within their amplitude, average out and are not flat', () => {
    const nx = 60;
    const nz = 30;
    let sum = 0;
    let peak = 0;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = -0.59 + (1.18 * i) / (nx - 1);
        const z = -inner / 2 + (inner * j) / (nz - 1);
        const dune = flat(x, z) - (tank.glass + FRONT);
        sum += dune;
        peak = Math.max(peak, Math.abs(dune));
      }
    }
    expect(peak).toBeLessThanOrEqual(DUNE_MAX);
    expect(peak).toBeGreaterThan(0.002);
    expect(Math.abs(sum / (nx * nz))).toBeLessThan(0.0005);
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
    const { nx, nz, heights } = space.floor;
    const rowMean = (j: number) =>
      heights.slice(j * nx, (j + 1) * nx).reduce((sum, h) => sum + h, 0) / nx;
    // Row 0 is the back pane (-z), the last row the front.
    expect(rowMean(0) - rowMean(nz - 1)).toBeGreaterThan(back - front - DUNE_MAX);
    expect(rowMean(0) - rowMean(nz - 1)).toBeLessThan(back - front + DUNE_MAX);
    const bounds = tankWaterBounds(space);
    expect(bounds.min[0]).toBeCloseTo(
      -TANK_SIZES[size].dimensions.length / 2 + glass + WATER_INSET,
      12,
    );
  });
});
