import { describe, expect, it } from 'vitest';
import {
  blendCells,
  cellDirection,
  directionToUv,
  uvToDirection,
  viewBasis,
  type Vec3,
} from './octahedral.ts';

function directions(count: number): Vec3[] {
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  return Array.from({ length: count }, () => {
    const z = next() * 2 - 1;
    const angle = next() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(angle), z, r * Math.sin(angle)] as Vec3;
  });
}

const near = (a: Vec3, b: Vec3, digits = 9): void =>
  a.forEach((value, k) => expect(value).toBeCloseTo(b[k]!, digits));

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('octahedral mapping', () => {
  it('round-trips directions on both hemispheres', () => {
    for (const d of directions(500)) {
      const [u, v] = directionToUv(d);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      near(uvToDirection(u, v), d);
    }
  });

  it('puts +Y at the centre, the axes on the edge midpoints and -Y in all four corners', () => {
    near(uvToDirection(0.5, 0.5), [0, 1, 0]);
    near(uvToDirection(1, 0.5), [1, 0, 0]);
    near(uvToDirection(0, 0.5), [-1, 0, 0]);
    near(uvToDirection(0.5, 1), [0, 0, 1]);
    near(uvToDirection(0.5, 0), [0, 0, -1]);
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const)
      near(uvToDirection(u, v), [0, -1, 0]);
  });

  it('gives every frame of the grid a unit direction', () => {
    for (const grid of [2, 5, 8])
      for (let j = 0; j < grid; j++)
        for (let i = 0; i < grid; i++)
          expect(Math.hypot(...cellDirection(i, j, grid))).toBeCloseTo(1, 12);
  });

  it('puts the frames at grid points so odd grids contain the axis views', () => {
    near(cellDirection(4, 2, 5), [1, 0, 0]);
    near(cellDirection(2, 4, 5), [0, 0, 1]);
    near(cellDirection(2, 2, 5), [0, 1, 0]);
    near(cellDirection(0, 0, 5), [0, -1, 0]);
  });
});

describe('blendCells', () => {
  it('returns four in-range frames whose weights sum to 1', () => {
    for (const grid of [2, 8])
      for (const d of directions(300)) {
        const cells = blendCells(d, grid);
        expect(cells.reduce((sum, c) => sum + c.weight, 0)).toBeCloseTo(1, 12);
        for (const c of cells) {
          expect(c.i).toBeGreaterThanOrEqual(0);
          expect(c.i).toBeLessThanOrEqual(grid - 1);
          expect(c.j).toBeGreaterThanOrEqual(0);
          expect(c.j).toBeLessThanOrEqual(grid - 1);
          expect(c.weight).toBeGreaterThanOrEqual(0);
        }
      }
  });

  it('puts the whole weight on a frame with the same direction when looking exactly along it', () => {
    const grid = 8;
    for (const [i, j] of [
      [0, 0],
      [3, 5],
      [7, 7],
      [7, 2],
    ] as const) {
      const d = cellDirection(i, j, grid);
      const heavy = blendCells(d, grid).find((c) => c.weight > 0.999);
      expect(heavy).toBeDefined();
      near(cellDirection(heavy!.i, heavy!.j, grid), d);
    }
  });

  it('blends the two frames either side of a midpoint equally', () => {
    const weights = blendCells(uvToDirection(3.5 / 7, 4 / 7), 8).filter((c) => c.weight > 1e-9);
    expect(weights).toHaveLength(2);
    for (const c of weights) expect(c.weight).toBeCloseTo(0.5, 9);
  });
});

describe('viewBasis', () => {
  it('is orthonormal and right-handed for every frame', () => {
    for (let j = 0; j < 8; j++)
      for (let i = 0; i < 8; i++) {
        const { right, up, toward } = viewBasis(cellDirection(i, j, 8));
        expect(Math.hypot(...right)).toBeCloseTo(1, 12);
        expect(Math.hypot(...up)).toBeCloseTo(1, 12);
        expect(dot(right, up)).toBeCloseTo(0, 12);
        expect(dot(right, toward)).toBeCloseTo(0, 12);
        near(
          [
            right[1] * up[2] - right[2] * up[1],
            right[2] * up[0] - right[0] * up[2],
            right[0] * up[1] - right[1] * up[0],
          ],
          toward,
          12,
        );
      }
  });

  it('looks at a fish from its +Z side with +X to the right and +Y up', () => {
    const { right, up } = viewBasis([0, 0, 1]);
    near(right, [1, 0, 0]);
    near(up, [0, 1, 0]);
  });

  it('stays defined on the poles', () => {
    for (const d of [
      [0, 1, 0],
      [0, -1, 0],
    ] as Vec3[]) {
      const { right, up } = viewBasis(d);
      expect(Math.hypot(...right)).toBeCloseTo(1, 12);
      expect(Math.hypot(...up)).toBeCloseTo(1, 12);
    }
  });
});
