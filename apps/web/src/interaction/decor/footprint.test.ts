import { describe, expect, it } from 'vitest';
import { extentOf, footprintOf, insideTank, overlaps, rayHit } from './footprint';
import { item, spec } from './fixtures';

const boulder = spec('boulder-01');

describe('footprintOf', () => {
  it('centres on the piece and scales with it', () => {
    const f = footprintOf(boulder, item('boulder-01', 0.1, -0.05, { scale: 2 }));
    expect(f.cx).toBeCloseTo(0.1, 6);
    expect(f.hx).toBeCloseTo(0.12163 * 2, 6);
    expect(f.hz).toBeCloseTo(0.175 * 2, 6);
  });

  it('swaps the half extents on screen when turned a quarter', () => {
    const e = extentOf(footprintOf(boulder, item('boulder-01', 0, 0, { rotationY: Math.PI / 2 })));
    expect(e.x).toBeCloseTo(0.175, 6);
    expect(e.z).toBeCloseTo(0.12163, 6);
  });
});

describe('overlaps', () => {
  const at = (x: number, z: number, rotationY = 0) =>
    footprintOf(boulder, item('boulder-01', x, z, { rotationY }));

  it('is true for pieces sharing space and false once apart', () => {
    expect(overlaps(at(0, 0), at(0.1, 0))).toBe(true);
    expect(overlaps(at(0, 0), at(0.5, 0))).toBe(false);
  });

  it('honours the clearance gap', () => {
    const touching = at(0.24, 0);
    expect(overlaps(at(0, 0), touching, 0)).toBe(true);
    expect(overlaps(at(0, 0), at(0.25, 0), 0)).toBe(false);
    expect(overlaps(at(0, 0), at(0.25, 0), 0.01)).toBe(true);
  });

  it('sees a rotated neighbour corner', () => {
    expect(overlaps(at(0, 0), at(0.2, 0.28, Math.PI / 4))).toBe(true);
    expect(overlaps(at(0, 0), at(0.2, 0.5, Math.PI / 4))).toBe(false);
  });
});

describe('insideTank', () => {
  it('accepts a piece within the glass and rejects one past it', () => {
    const inside = footprintOf(boulder, item('boulder-01', 0.4, 0));
    expect(insideTank(inside, 0.589, 0.239)).toBe(true);
    const past = footprintOf(boulder, item('boulder-01', 0.5, 0));
    expect(insideTank(past, 0.589, 0.239)).toBe(false);
  });

  it('counts rotation: a turned long piece needs more depth', () => {
    const wood = spec('dead-tree-trunk-02');
    const along = footprintOf(wood, item('dead-tree-trunk-02', 0, 0.12));
    const across = footprintOf(
      wood,
      item('dead-tree-trunk-02', 0, 0.12, { rotationY: Math.PI / 2 }),
    );
    expect(insideTank(along, 0.589, 0.239)).toBe(true);
    expect(insideTank(across, 0.589, 0.239)).toBe(false);
  });
});

describe('rayHit', () => {
  const f = footprintOf(boulder, item('boulder-01', 0, 0));

  it('hits from above and returns the distance', () => {
    const t = rayHit(f, { origin: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: -1, z: 0 } });
    expect(t).not.toBeNull();
    expect(t as number).toBeGreaterThan(0.5);
    expect(t as number).toBeLessThan(1);
  });

  it('misses beside the piece', () => {
    expect(rayHit(f, { origin: { x: 0.5, y: 1, z: 0 }, dir: { x: 0, y: -1, z: 0 } })).toBeNull();
  });
});
