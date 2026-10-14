import { describe, expect, it } from 'vitest';
import {
  HULL_DIRECTIONS,
  MAX_HULL_VERTICES,
  colliderBoundingSphere,
  colliderListSchema,
  colliderSchema,
  fitHullPlanes,
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

describe('fitHullPlanes', () => {
  const at = (a: ArrayLike<number>, i: number): number => {
    const v = a[i];
    if (v === undefined) throw new RangeError(`index ${i} out of range`);
    return v;
  };
  let seed = 5;
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const points: number[] = [];
  for (let i = 0; i < 40; i++) {
    points.push((next() * 2 - 1) * 0.2, next() * 0.3, (next() * 2 - 1) * 0.1);
  }
  const planes = fitHullPlanes(points);
  const axis = (k: number): number[] => points.filter((_, i) => i % 3 === k);

  it('uses 54 unit directions: the axes, then a spiral from the north to the south pole', () => {
    expect(HULL_DIRECTIONS.length).toBe(54 * 3);
    expect(Array.from(HULL_DIRECTIONS.subarray(0, 18))).toEqual([
      1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1,
    ]);
    for (let k = 0; k < HULL_DIRECTIONS.length; k += 3) {
      const n = [at(HULL_DIRECTIONS, k), at(HULL_DIRECTIONS, k + 1), at(HULL_DIRECTIONS, k + 2)];
      expect(Math.hypot(...n)).toBeCloseTo(1, 12);
    }
    expect(at(HULL_DIRECTIONS, 19)).toBeCloseTo(1 - 1 / 48, 12);
    expect(at(HULL_DIRECTIONS, HULL_DIRECTIONS.length - 2)).toBeCloseTo(-1 + 1 / 48, 12);
  });

  it('puts the bounding box in the first six planes', () => {
    const [xs, ys, zs] = [axis(0), axis(1), axis(2)];
    expect([0, 1, 2, 3, 4, 5].map((p) => at(planes, p * 4 + 3))).toEqual([
      Math.max(...xs),
      -Math.min(...xs),
      Math.max(...ys),
      -Math.min(...ys),
      Math.max(...zs),
      -Math.min(...zs),
    ]);
  });

  it('makes every plane a support plane that touches the points', () => {
    expect(planes.length).toBe(54 * 4);
    for (let k = 0, j = 0; k < planes.length; k += 4, j += 3) {
      const n = [at(planes, k), at(planes, k + 1), at(planes, k + 2)] as const;
      expect(n).toEqual(Array.from(HULL_DIRECTIONS.subarray(j, j + 3)));
      let support = -Infinity;
      for (let i = 0; i < points.length; i += 3) {
        support = Math.max(
          support,
          n[0] * at(points, i) + n[1] * at(points, i + 1) + n[2] * at(points, i + 2),
        );
      }
      expect(at(planes, k + 3)).toBe(support);
    }
  });

  it('rejects fewer than four points', () => {
    expect(() => fitHullPlanes(points.slice(0, 9))).toThrow('at least 4');
  });
});
