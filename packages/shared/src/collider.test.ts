import { describe, expect, it } from 'vitest';
import {
  MAX_HULL_VERTICES,
  colliderBoundingSphere,
  colliderListSchema,
  colliderSchema,
  maxTetrahedronVolume,
} from './collider.js';

const tetra = [
  [0, 0, 0],
  [0.1, 0, 0],
  [0, 0.1, 0],
  [0, 0, 0.1],
];

describe('collider schema', () => {
  it('accepts every shape and fills box defaults', () => {
    const box = colliderSchema.parse({
      id: 'rock-1',
      kind: 'box',
      hard: true,
      center: [0, 0.1, 0],
      halfExtents: [0.1, 0.05, 0.08],
    });
    expect(box).toMatchObject({ rotationY: 0, rounding: 0 });
    for (const c of [
      { id: 's', kind: 'sphere', hard: true, center: [0, 0, 0], radius: 0.1 },
      { id: 'c', kind: 'capsule', hard: false, a: [0, 0, 0], b: [0, 0.3, 0], radius: 0.02 },
      { id: 'h', kind: 'hull', hard: true, vertices: tetra },
    ]) {
      expect(colliderSchema.safeParse(c).success).toBe(true);
    }
  });

  it('maps onto the sim decor fields unchanged', () => {
    const c = colliderSchema.parse({
      id: 'x',
      kind: 'capsule',
      hard: true,
      a: [0, 0, 0],
      b: [0.2, 0, 0],
      radius: 0.03,
    });
    expect(Object.keys(c).sort()).toEqual(['a', 'b', 'hard', 'id', 'kind', 'radius']);
  });

  it('restricts ids to a safe charset', () => {
    const sphere = { kind: 'sphere', hard: true, center: [0, 0, 0], radius: 0.1 };
    for (const id of ['rock_1.a:b-c', 'A'.repeat(64)]) {
      expect(colliderSchema.safeParse({ ...sphere, id }).success).toBe(true);
    }
    for (const id of ['a b', 'a/b', '<x>', 'ü', 'A'.repeat(65)]) {
      expect(colliderSchema.safeParse({ ...sphere, id }).success).toBe(false);
    }
  });

  it('rejects non-finite and out-of-range numbers', () => {
    const sphere = { id: 's', kind: 'sphere', hard: true, center: [0, 0, 0], radius: 0.1 };
    expect(colliderSchema.safeParse({ ...sphere, radius: NaN }).success).toBe(false);
    expect(colliderSchema.safeParse({ ...sphere, radius: 0 }).success).toBe(false);
    expect(colliderSchema.safeParse({ ...sphere, center: [0, Infinity, 0] }).success).toBe(false);
    expect(colliderSchema.safeParse({ ...sphere, center: [0, 1e6, 0] }).success).toBe(false);
    expect(colliderSchema.safeParse({ ...sphere, id: '' }).success).toBe(false);
    expect(colliderSchema.safeParse({ ...sphere, extra: 1 }).success).toBe(false);
  });

  it('rejects a box rounded beyond its smallest half extent', () => {
    const r = colliderSchema.safeParse({
      id: 'b',
      kind: 'box',
      hard: true,
      center: [0, 0, 0],
      halfExtents: [0.1, 0.02, 0.1],
      rounding: 0.05,
    });
    expect(r.success).toBe(false);
  });
});

describe('hull validation', () => {
  const hull = (vertices: unknown, extra: object = {}) =>
    colliderSchema.safeParse({ id: 'h', kind: 'hull', hard: true, vertices, ...extra });

  it('measures tetrahedron volume, zero for flat and collinear sets', () => {
    expect(maxTetrahedronVolume(tetra as [number, number, number][])).toBeCloseTo(0.1 ** 3 / 6, 12);
    expect(
      maxTetrahedronVolume([
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
      ]),
    ).toBe(0);
    expect(maxTetrahedronVolume([])).toBe(0);
  });

  it('rejects coplanar, collinear and coincident vertices', () => {
    expect(
      hull([
        [0, 0, 0],
        [0.1, 0, 0],
        [0, 0.1, 0],
        [0.1, 0.1, 0],
      ]).success,
    ).toBe(false);
    expect(
      hull([
        [0, 0, 0],
        [0.1, 0, 0],
        [0.2, 0, 0],
        [0.3, 0, 0],
      ]).success,
    ).toBe(false);
    expect(hull(Array.from({ length: 5 }, () => [0.1, 0.1, 0.1])).success).toBe(false);
  });

  it('rejects too few and too many vertices', () => {
    expect(hull(tetra.slice(0, 3)).success).toBe(false);
    const many = Array.from({ length: MAX_HULL_VERTICES + 1 }, (_, i) => [
      Math.cos(i) * 0.1,
      (i % 7) * 0.01,
      Math.sin(i) * 0.1,
    ]);
    expect(hull(many).success).toBe(false);
    expect(hull(many.slice(0, MAX_HULL_VERTICES)).success).toBe(true);
  });

  it('rejects non-finite vertices', () => {
    expect(hull([...tetra.slice(0, 3), [0, 0, NaN]]).success).toBe(false);
  });

  it('rejects a precomputed planes field', () => {
    expect(hull(tetra, { planes: [0, 1, 0, 0.1] }).success).toBe(false);
  });

  it('scales the degeneracy threshold with the hull size', () => {
    const scaled = (k: number) => tetra.map((v) => v.map((c) => c * k));
    expect(hull(scaled(10)).success).toBe(true);
    expect(hull(scaled(0.01)).success).toBe(true);
    expect(hull([...tetra.slice(0, 3), [0.03, 0.03, 1e-9]]).success).toBe(false);
  });
});

describe('collider list', () => {
  const s = (id: string) => ({ id, kind: 'sphere', hard: true, center: [0, 0, 0], radius: 0.1 });

  it('requires unique ids', () => {
    expect(colliderListSchema.safeParse([s('a'), s('b')]).success).toBe(true);
    expect(colliderListSchema.safeParse([s('a'), s('a')]).success).toBe(false);
  });

  it('is validated as a whole: one bad entry rejects the list', () => {
    expect(colliderListSchema.safeParse([s('a'), { ...s('b'), radius: -1 }]).success).toBe(false);
  });
});

describe('colliderBoundingSphere', () => {
  it('covers each shape', () => {
    expect(
      colliderBoundingSphere({
        id: 's',
        kind: 'sphere',
        hard: true,
        center: [1, 2, 3],
        radius: 0.5,
      }),
    ).toEqual({ center: [1, 2, 3], radius: 0.5 });
    const capsule = colliderBoundingSphere({
      id: 'c',
      kind: 'capsule',
      hard: true,
      a: [0, 0, 0],
      b: [0, 0.4, 0],
      radius: 0.05,
    });
    expect(capsule.center).toEqual([0, 0.2, 0]);
    expect(capsule.radius).toBeCloseTo(0.25, 12);
    const box = colliderBoundingSphere(
      colliderSchema.parse({
        id: 'b',
        kind: 'box',
        hard: true,
        center: [0, 0, 0],
        halfExtents: [0.3, 0.4, 0.12],
      }),
    );
    expect(box.radius).toBeCloseTo(Math.hypot(0.3, 0.4, 0.12), 12);
  });

  it('bounds every hull vertex', () => {
    const hull = colliderSchema.parse({ id: 'h', kind: 'hull', hard: true, vertices: tetra });
    const { center, radius } = colliderBoundingSphere(hull);
    if (hull.kind !== 'hull') throw new Error('expected a hull');
    for (const v of hull.vertices) {
      expect(Math.hypot(v[0] - center[0], v[1] - center[1], v[2] - center[2])).toBeLessThanOrEqual(
        radius + 1e-12,
      );
    }
  });
});
