import { describe, expect, it } from 'vitest';
import { pairwiseDistanceSq, selectBalanced, selectNearest } from './neighbours.ts';

function setup(points: readonly (readonly [number, number, number])[]): {
  n: number;
  dist: Float64Array;
} {
  const n = points.length;
  const pos = new Float64Array(points.flat());
  const dist = new Float64Array(n * n);
  pairwiseDistanceSq(pos, n, dist);
  return { n, dist };
}

function nearest(
  points: readonly (readonly [number, number, number])[],
  i: number,
  k: number,
  group: Int32Array | null = null,
  maxDistSq = Infinity,
): number[] {
  const { n, dist } = setup(points);
  const out = new Int32Array(k + 2).fill(-9);
  const found = selectNearest(dist, n, i, k, group, maxDistSq, out, 1, new Float64Array(k));
  expect(out[0]).toBe(-9);
  return Array.from(out.subarray(1, 1 + found));
}

describe('pairwiseDistanceSq', () => {
  it('fills a symmetric matrix of squared distances', () => {
    const { n, dist } = setup([
      [0, 0, 0],
      [3, 4, 0],
      [0, 0, 2],
    ]);
    expect(dist[0 * n + 1]).toBe(25);
    expect(dist[1 * n + 0]).toBe(25);
    expect(dist[0 * n + 2]).toBe(4);
    expect(dist[1 * n + 1]).toBe(0);
  });
});

describe('selectNearest', () => {
  const line: [number, number, number][] = [0, 5, 1, 9, 2, 100, 3].map((x) => [x, 0, 0]);

  it('returns the k nearest, nearest first, however far they are (topological)', () => {
    expect(nearest(line, 0, 3)).toEqual([2, 4, 6]);
    const sparse: [number, number, number][] = [0, 50, 10, 30].map((x) => [x, 0, 0]);
    expect(nearest(sparse, 0, 2)).toEqual([2, 3]);
  });

  it('returns fewer than k when there are not enough candidates', () => {
    expect(nearest(line.slice(0, 3), 0, 7)).toEqual([2, 1]);
    expect(nearest([[0, 0, 0]], 0, 3)).toEqual([]);
  });

  it('respects a group filter and a distance cap', () => {
    const group = new Int32Array([0, 0, 1, 0, 1, 0, 0]);
    expect(nearest(line, 0, 3, group)).toEqual([6, 1, 3]);
    expect(nearest(line, 0, 7, null, 4.5)).toEqual([2, 4]);
  });

  it('breaks distance ties by the lower index', () => {
    const ring: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
    ];
    expect(nearest(ring, 0, 2)).toEqual([1, 2]);
    expect(nearest(ring, 0, 4)).toEqual([1, 2, 3, 4]);
  });

  it('returns nothing for k = 0', () => {
    expect(nearest(line, 0, 0)).toEqual([]);
  });
});

function balanced(
  points: readonly (readonly [number, number, number])[],
  i: number,
  k: number,
  angleRad: number,
  pool = 16,
  maxDistSq = Infinity,
): number[] {
  const n = points.length;
  const pos = new Float64Array(points.flat());
  const dist = new Float64Array(n * n);
  pairwiseDistanceSq(pos, n, dist);
  const out = new Int32Array(k + 2).fill(-9);
  const found = selectBalanced(
    dist,
    pos,
    n,
    i,
    k,
    pool,
    null,
    maxDistSq,
    Math.cos(angleRad),
    out,
    1,
    { idx: new Int32Array(pool), dist: new Float64Array(pool), dir: new Float64Array(3 * k) },
  );
  expect(out[0]).toBe(-9);
  expect(out[k + 1]).toBe(-9);
  return Array.from(out.subarray(1, 1 + found));
}

describe('selectBalanced', () => {
  // Fish 0 sits at the edge of its own clump (1-4, all toward +x) with another clump at -x.
  const twoClumps: [number, number, number][] = [
    [0, 0, 0],
    [1, 0, 0],
    [1.1, 0.1, 0],
    [1.2, -0.1, 0],
    [1.3, 0, 0.1],
    [-3, 0, 0],
    [-3.2, 0.2, 0],
  ];

  it('reaches past a crowded bearing to the next clump, where k-nearest does not', () => {
    expect(nearest(twoClumps, 0, 3)).toEqual([1, 2, 3]);
    expect(balanced(twoClumps, 0, 3, 0.7)).toEqual([1, 5]);
  });

  it('keeps every candidate when the exclusion angle is zero, as k-nearest does', () => {
    expect(balanced(twoClumps, 0, 3, 0)).toEqual(nearest(twoClumps, 0, 3));
  });

  it('stops at k and looks only at the nearest pool', () => {
    const star: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [-1.1, 0, 0],
      [0, 1.2, 0],
      [0, -1.3, 0],
      [0, 0, 1.4],
    ];
    expect(balanced(star, 0, 2, 0.7)).toEqual([1, 2]);
    expect(balanced(star, 0, 7, 0.7)).toEqual([1, 2, 3, 4, 5]);
    expect(balanced(twoClumps, 0, 3, 0.7, 4)).toEqual([1]);
  });

  it('respects the distance cap and returns nothing for k = 0 or a lone fish', () => {
    expect(balanced(twoClumps, 0, 3, 0.7, 16, 4)).toEqual([1]);
    expect(balanced(twoClumps, 0, 0, 0.7)).toEqual([]);
    expect(balanced([[0, 0, 0]], 0, 3, 0.7)).toEqual([]);
  });

  it('takes a fish at the same point without letting it block a bearing', () => {
    expect(
      balanced(
        [
          [0, 0, 0],
          [0, 0, 0],
          [1, 0, 0],
        ],
        0,
        3,
        0.7,
      ),
    ).toEqual([1, 2]);
  });
});
