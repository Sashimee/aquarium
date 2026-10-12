import { describe, expect, it } from 'vitest';
import { resolvePenetration, smoothGradient, TankSdf } from './sdf.ts';

const tank = { width: 1, height: 0.5, depth: 0.4 };
const sdf = new TankSdf(tank);
const n = new Float64Array(3);

describe('TankSdf', () => {
  it('measures the distance to the nearest face from inside, normal pointing inwards', () => {
    expect(sdf.sample(0, 0.25, 0, n)).toBeCloseTo(0.2, 12);
    expect(Array.from(n).map(Math.abs)).toEqual([0, 0, 1]);

    expect(sdf.sample(0.45, 0.25, 0, n)).toBeCloseTo(0.05, 12);
    expect(Array.from(n)).toEqual([-1, 0, 0]);

    expect(sdf.sample(0, 0.02, 0, n)).toBeCloseTo(0.02, 12);
    expect(Array.from(n)).toEqual([0, 1, 0]);

    expect(sdf.sample(0, 0.49, 0, n)).toBeCloseTo(0.01, 12);
    expect(Array.from(n)).toEqual([0, -1, 0]);
  });

  it('is negative outside the box, with the exact distance and an inward normal', () => {
    expect(sdf.sample(0.8, 0.25, 0, n)).toBeCloseTo(-0.3, 12);
    expect(Array.from(n)).toEqual([-1, 0, 0]);
    expect(sdf.sample(0.8, 0.9, 0, n)).toBeCloseTo(-0.5, 12);
    expect(n[0]).toBeCloseTo(-0.6, 12);
    expect(n[1]).toBeCloseTo(-0.8, 12);
  });

  it('rejects non-positive or non-finite dimensions', () => {
    expect(() => new TankSdf({ width: 0, height: 1, depth: 1 })).toThrow(/tank.width/);
    expect(() => new TankSdf({ width: 1, height: Number.NaN, depth: 1 })).toThrow(/tank.height/);
  });
});

describe('smoothGradient', () => {
  it('bisects a corner instead of snapping to one wall', () => {
    const out = new Float64Array(3);
    smoothGradient(sdf, 0.45, 0.25, 0.15, 0.05, out, new Float64Array(3));
    expect(out[0]).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(out[2]).toBeCloseTo(-Math.SQRT1_2, 6);
  });
});

describe('resolvePenetration', () => {
  it('pushes a point out of a wall and a corner to the requested clearance', () => {
    for (const p of [
      [0.49, 0.25, 0],
      [0.6, 0.6, 0.3],
      [0, -0.2, 0],
    ]) {
      const pos = new Float64Array(p);
      expect(resolvePenetration(sdf, pos, 0, 0.03, n)).toBe(true);
      expect(sdf.sample(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0, n)).toBeGreaterThanOrEqual(
        0.03 - 1e-12,
      );
    }
  });

  it('reports failure when the clearance cannot exist', () => {
    const pos = new Float64Array([0, 0.25, 0]);
    expect(resolvePenetration(sdf, pos, 0, 0.3, n)).toBe(false);
  });
});
