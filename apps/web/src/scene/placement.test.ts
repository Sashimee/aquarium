import { describe, expect, it } from 'vitest';
import type { PlantPatch } from '@aquarium/shared';
import { GLASS_SHRINK_FLOOR, mulberry32, scaleForRoom, scatterPatch } from './placement';

const patch: PlantPatch = {
  id: 'p',
  assetId: 'a',
  center: [0, 0],
  radius: 0.15,
  count: 30,
  scale: [0.8, 1.2],
  seed: 7,
};
const extent = { halfLength: 0.5, halfDepth: 0.2 };
const flat = () => 0.1;
const open = () => false;

describe('scatterPatch', () => {
  it('is deterministic for a seed', () => {
    expect(scatterPatch(patch, flat, open, extent)).toEqual(
      scatterPatch(patch, flat, open, extent),
    );
  });

  it('places the requested count inside the disc and tank', () => {
    const plants = scatterPatch(patch, flat, open, extent);
    expect(plants).toHaveLength(30);
    for (const p of plants) {
      expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(patch.radius + 1e-9);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(extent.halfDepth);
      expect(p.scale).toBeGreaterThanOrEqual(0.8);
      expect(p.scale).toBeLessThanOrEqual(1.2);
    }
  });

  it('keeps plants apart so any thinned prefix has no overlaps', () => {
    const plants = scatterPatch(patch, flat, open, extent);
    const floor = 0.7 * Math.sqrt((Math.PI * patch.radius ** 2) / patch.count) * 0.85 ** 3;
    for (let i = 0; i < plants.length; i++) {
      for (let j = i + 1; j < plants.length; j++) {
        const a = plants[i];
        const b = plants[j];
        if (a && b) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(floor);
      }
    }
  });

  it('avoids blocked ground', () => {
    const plants = scatterPatch(patch, flat, (x) => x > 0, extent);
    expect(plants.length).toBeGreaterThan(0);
    expect(plants.every((p) => p.x <= 0)).toBe(true);
  });

  it('roots plants slightly below the ground height', () => {
    const plants = scatterPatch(patch, (x) => 0.1 + x, open, extent);
    for (const p of plants) expect(p.y).toBeLessThan(0.1 + p.x);
  });

  it('terminates when the area is fully blocked', () => {
    expect(scatterPatch(patch, flat, () => true, extent)).toEqual([]);
  });
});

describe('mulberry32', () => {
  it('yields values in [0,1) and repeats per seed', () => {
    const a = mulberry32(5);
    const b = mulberry32(5);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('scatterPatch glass clearance', () => {
  const edge: PlantPatch = { ...patch, center: [0.45, 0.18], radius: 0.2, count: 40 };

  it('keeps the whole plant, not just the root, inside the extent', () => {
    const reach = (scale: number) => 0.1 * scale;
    const plants = scatterPatch(edge, flat, open, extent, reach);
    expect(plants.length).toBeGreaterThan(0);
    for (const p of plants) {
      expect(Math.abs(p.x) + reach(p.scale)).toBeLessThanOrEqual(extent.halfLength + 1e-9);
      expect(Math.abs(p.z) + reach(p.scale)).toBeLessThanOrEqual(extent.halfDepth + 1e-9);
    }
  });

  it('lets roots reach the wall when no reach is given', () => {
    const plants = scatterPatch(edge, flat, open, extent);
    expect(plants.some((p) => Math.abs(p.z) > extent.halfDepth - 0.05)).toBe(true);
  });
});

describe('scatterPatch back row', () => {
  const half = { halfLength: 0.585, halfDepth: 0.235 };
  const reach = (scale: number) => 0.063 + 0.173 * scale;
  const back: PlantPatch = {
    ...patch,
    center: [0.1, -0.15],
    radius: 0.1,
    count: 16,
    scale: [0.6, 0.9],
  };

  it('keeps a patch whose reach is near the half-depth behind mid-depth', () => {
    const plants = scatterPatch(back, flat, open, half, reach);
    expect(plants).toHaveLength(16);
    for (const p of plants) expect(p.z).toBeLessThan(-0.05);
    const meanZ = plants.reduce((sum, p) => sum + p.z, 0) / plants.length;
    expect(meanZ).toBeLessThan(-0.09);
  });

  it('shrinks plants near the glass rather than moving them, never below the floor', () => {
    const plants = scatterPatch(back, flat, open, half, reach);
    for (const p of plants) {
      expect(Math.abs(p.z) + reach(p.scale)).toBeLessThanOrEqual(half.halfDepth + 1e-9);
      expect(p.scale).toBeGreaterThanOrEqual(0.6 * GLASS_SHRINK_FLOOR - 1e-9);
    }
  });
});

describe('scaleForRoom', () => {
  const reach = (scale: number) => 0.05 + 0.2 * scale;

  it('keeps the drawn scale when it fits', () => {
    expect(scaleForRoom(0.8, 0.3, reach)).toBe(0.8);
  });

  it('shrinks to exactly fill the room', () => {
    expect(reach(scaleForRoom(0.9, 0.17, reach))).toBeCloseTo(0.17, 10);
  });

  it('stops at the floor when the room is too small', () => {
    expect(scaleForRoom(0.9, 0.01, reach)).toBeCloseTo(0.9 * GLASS_SHRINK_FLOOR, 10);
  });
});
