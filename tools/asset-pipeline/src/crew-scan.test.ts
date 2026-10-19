import { describe, expect, it } from 'vitest';
import {
  areaCentroid,
  boundsOf,
  canonicalVertices,
  connectedComponents,
  place,
  principalAxes,
} from './crew-scan.ts';
import type { Part } from './parts.ts';

function partOf(positions: number[], indices: number[]): Part {
  const count = positions.length / 3;
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from({ length: count * 3 }, (_, i) => (i % 3 === 0 ? 1 : 0)),
    uvs: new Float32Array(count * 2),
    indices: Uint32Array.from(indices),
    material: 'm',
    extra: {},
  };
}

describe('canonicalVertices', () => {
  it('merges vertices at the same quantised position and keeps distinct ones apart', () => {
    const canon = canonicalVertices([0, 0, 0, 1, 0, 0, 0.0001, 0, 0, 0, 0, 0], 0.01);
    expect(Array.from(canon)).toEqual([0, 1, 0, 0]);
  });
});

describe('connectedComponents', () => {
  const positions = [
    0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 5, 0, 0, 6, 0, 0, 5, 1, 0,
  ];
  const indices = [0, 1, 2, 3, 5, 4, 6, 7, 8];

  it('joins triangles through seam duplicates and numbers components by descending size', () => {
    const canon = canonicalVertices(positions, 0.01);
    const { label, sizes } = connectedComponents(canon, indices, () => true);
    expect(sizes).toEqual([6, 3]);
    expect(label[0]).toBe(label[5]);
    expect(label[0]).toBe(0);
    expect(label[6]).toBe(1);
  });

  it('labels excluded vertices -1 and splits where an edge loses an end', () => {
    const canon = canonicalVertices(positions, 0.01);
    const { label, sizes } = connectedComponents(
      canon,
      indices,
      (v) => v < 6 && v !== 2 && v !== 4,
    );
    expect(label[6]).toBe(-1);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(4);
  });
});

describe('principalAxes', () => {
  it('finds the long axis of an elongated cloud with its variance first', () => {
    const points: [number, number, number][] = [];
    for (let i = -10; i <= 10; i++)
      for (const s of [-1, 1]) points.push([s * 0.2, i * 0.1, s * 0.05]);
    const { axes, variances, centre } = principalAxes(points);
    expect(Math.abs(axes[0][1])).toBeGreaterThan(0.99);
    expect(variances[0]).toBeGreaterThan(variances[1]);
    expect(variances[1]).toBeGreaterThanOrEqual(variances[2]);
    expect(Math.hypot(...centre)).toBeLessThan(1e-9);
  });

  it('rejects an empty set', () => {
    expect(() => principalAxes([])).toThrow(/no points/);
  });
});

describe('place', () => {
  it('rotates positions and normals into the target frame, scales and shifts', () => {
    const part = partOf([1, 0, 0, 2, 0, 0, 1, 1, 0], [0, 1, 2]);
    place(part, {
      origin: [1, 0, 0],
      right: [0, 0, 1],
      up: [1, 0, 0],
      forward: [0, 1, 0],
      scale: 2,
      shift: [0, 0.5, 0],
    });
    expect(Array.from(part.positions.slice(3, 6))).toEqual([0, 2.5, 0]);
    expect(Array.from(part.positions.slice(6, 9))).toEqual([0, 0.5, 2]);
    expect(Array.from(part.normals.slice(0, 3))).toEqual([0, 1, 0]);
  });
});

describe('boundsOf and areaCentroid', () => {
  it('measures the box and weights the centroid by triangle area', () => {
    const positions = [0, 0, 0, 2, 0, 0, 0, 2, 0, 10, 10, 10, 10.1, 10, 10, 10, 10.1, 10];
    expect(boundsOf(positions)).toEqual({ min: [0, 0, 0], max: [10.1, 10.1, 10] });
    const c = areaCentroid(positions, [0, 1, 2]);
    expect(c[0]).toBeCloseTo(2 / 3);
    expect(c[1]).toBeCloseTo(2 / 3);
    expect(areaCentroid(positions, [])).toEqual([0, 0, 0]);
  });
});
