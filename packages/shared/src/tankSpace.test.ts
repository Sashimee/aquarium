import { describe, expect, it } from 'vitest';
import {
  createTankSpace,
  legacyYToTankSpace,
  sampleFloor,
  sampleFloorSlope,
  tankSpaceSchema,
  tankSpaceYToLegacy,
  tankWaterBounds,
  tankWaterTop,
} from './tankSpace.js';

const params = { width: 1.2, depth: 0.5, height: 0.5, glass: 0.01, freeboard: 0.03 };
const flat = createTankSpace(params, () => 0.06);
const ramp = createTankSpace({ ...params, nx: 5, nz: 5 }, (x, z) => 0.15 + 0.1 * x + 0.2 * z);

describe('tank space', () => {
  it('puts the water between the glass top and the freeboard line', () => {
    expect(tankWaterTop(flat)).toBeCloseTo(0.47, 12);
    const b = tankWaterBounds(flat);
    expect(b.min[1]).toBeCloseTo(0.011, 12);
    expect(b.max[1]).toBeCloseTo(0.47, 12);
    expect(b.max[0]).toBeCloseTo(0.6 - 0.01 - 0.001, 12);
    expect(b.min[2]).toBeCloseTo(-(0.25 - 0.01 - 0.001), 12);
  });

  it('records the floor extrema', () => {
    expect(flat.floor.min).toBe(0.06);
    expect(flat.floor.max).toBe(0.06);
    expect(ramp.floor.max).toBeGreaterThan(ramp.floor.min);
  });

  it('samples a flat floor everywhere, also outside the footprint', () => {
    expect(sampleFloor(flat, 0, 0)).toBeCloseTo(0.06, 12);
    expect(sampleFloor(flat, 9, -9)).toBeCloseTo(0.06, 12);
  });

  it('reproduces a planar floor exactly between grid vertices', () => {
    for (const [x, z] of [
      [0, 0],
      [0.31, -0.11],
      [-0.5, 0.2],
    ] as const) {
      expect(sampleFloor(ramp, x, z)).toBeCloseTo(0.15 + 0.1 * x + 0.2 * z, 9);
    }
  });

  it('returns the exact vertex heights at the corners and clamps beyond them', () => {
    const hx = 0.6 - 0.01;
    const hz = 0.25 - 0.01;
    expect(sampleFloor(ramp, -hx, -hz)).toBeCloseTo(0.15 - 0.1 * hx - 0.2 * hz, 9);
    expect(sampleFloor(ramp, hx, hz)).toBeCloseTo(0.15 + 0.1 * hx + 0.2 * hz, 9);
    expect(sampleFloor(ramp, 100, 100)).toBeCloseTo(sampleFloor(ramp, hx, hz), 12);
  });

  it('reports the slope of a plane', () => {
    const [dx, dz] = sampleFloorSlope(ramp, 0.1, 0.05);
    expect(dx).toBeCloseTo(0.1, 9);
    expect(dz).toBeCloseTo(0.2, 9);
  });

  it('has no slope outside the footprint', () => {
    expect(sampleFloorSlope(ramp, 5, 0)).toEqual([0, 0]);
    expect(sampleFloorSlope(ramp, 0, -5)).toEqual([0, 0]);
  });

  it('converts between the sim frame and tank space', () => {
    const y = legacyYToTankSpace(ramp, 0.2, 0.1, 0);
    expect(y).toBeCloseTo(sampleFloor(ramp, 0.2, 0.1), 12);
    expect(tankSpaceYToLegacy(ramp, 0.2, 0.1, y + 0.03)).toBeCloseTo(0.03, 12);
  });

  it('round-trips through the schema', () => {
    expect(tankSpaceSchema.parse(JSON.parse(JSON.stringify(ramp)))).toEqual(ramp);
  });
});

describe('tank space validation', () => {
  const bad = (mutate: (t: typeof flat) => unknown) =>
    tankSpaceSchema.safeParse(mutate(JSON.parse(JSON.stringify(flat)) as typeof flat)).success;

  it('rejects a wrong sample count', () => {
    expect(bad((t) => ({ ...t, floor: { ...t.floor, heights: t.floor.heights.slice(1) } }))).toBe(
      false,
    );
  });

  it('rejects min and max that disagree with the samples', () => {
    expect(bad((t) => ({ ...t, floor: { ...t.floor, min: 0.01 } }))).toBe(false);
    expect(bad((t) => ({ ...t, floor: { ...t.floor, max: 0.2 } }))).toBe(false);
  });

  it('rejects non-finite heights', () => {
    expect(
      bad((t) => ({ ...t, floor: { ...t.floor, heights: t.floor.heights.map(() => NaN) } })),
    ).toBe(false);
  });

  it('rejects a substrate below the glass or above the water', () => {
    expect(() => createTankSpace(params, () => 0.0)).toThrow();
    expect(() => createTankSpace(params, () => 0.48)).toThrow();
  });

  it('rejects an inverted water box', () => {
    expect(bad((t) => ({ ...t, inset: 0.05, glass: 0.05, depth: 0.1, width: 1.2 }))).toBe(false);
    expect(bad((t) => ({ ...t, width: 0.04, glass: 0.015, inset: 0.01 }))).toBe(false);
    expect(bad((t) => ({ ...t, depth: 0.04, glass: 0.015, inset: 0.01 }))).toBe(false);
    const r = tankSpaceSchema.safeParse({
      ...JSON.parse(JSON.stringify(flat)),
      freeboard: 0.4895,
      floor: {
        ...flat.floor,
        min: 0.0105,
        max: 0.0105,
        heights: flat.floor.heights.map(() => 0.0105),
      },
    });
    expect(r.error?.issues.map((i) => i.message)).toContain(
      'water surface must lie above the bottom glass plus inset',
    );
  });

  it('rejects impossible glass and freeboard', () => {
    expect(bad((t) => ({ ...t, glass: 0.3 }))).toBe(false);
    expect(bad((t) => ({ ...t, freeboard: 0.5 }))).toBe(false);
    expect(bad((t) => ({ ...t, extra: 1 }))).toBe(false);
  });
});
