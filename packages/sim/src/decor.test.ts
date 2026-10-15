import { fitHullPlanes, type Collider } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { compileCollider, DecorField, UnionSdf } from './decor.ts';
import {
  angelfish,
  ARCHETYPES,
  bronzeCorydoras,
  cherryShrimp,
  neonTetra,
  REEF_DECOR,
  REEF_TANK,
  SHOW_DECOR,
  SHOW_TANK,
  spawnMany,
} from './fixtures.ts';
import { Rng } from './rng.ts';
import { TankSdf } from './sdf.ts';
import { World } from './world.ts';

const PENETRATION_EPSILON = 1e-9;

const n = new Float64Array(3);
const m = new Float64Array(3);

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

function bruteForce(colliders: readonly Collider[], reach: number) {
  const primitives = colliders.map(compileCollider);
  return (x: number, y: number, z: number, normal: Float64Array): number => {
    let best = reach;
    normal.set([0, 1, 0]);
    for (const p of primitives) {
      const d = p.sample(x, y, z, m);
      if (d < best) {
        best = d;
        normal.set(m);
      }
    }
    return best;
  };
}

function expectSameField(
  a: (x: number, y: number, z: number, nrm: Float64Array) => number,
  b: (x: number, y: number, z: number, nrm: Float64Array) => number,
  tank: { width: number; height: number; depth: number },
  seed: number,
): void {
  const rng = new Rng(seed);
  const na = new Float64Array(3);
  const nb = new Float64Array(3);
  for (let k = 0; k < 4000; k++) {
    const x = rng.signed() * tank.width * 0.5;
    const y = rng.range(0, tank.height);
    const z = rng.signed() * tank.depth * 0.5;
    const da = a(x, y, z, na);
    const db = b(x, y, z, nb);
    expect(da).toBeCloseTo(db, 12);
    if (db < 0.2) {
      expect(at(na, 0)).toBeCloseTo(at(nb, 0), 9);
      expect(at(na, 1)).toBeCloseTo(at(nb, 1), 9);
      expect(at(na, 2)).toBeCloseTo(at(nb, 2), 9);
    }
  }
}

describe('decor primitives', () => {
  it('names the collider and the field a bad shape fails on', () => {
    expect(() =>
      compileCollider({
        id: 'decor:p2',
        hard: true,
        kind: 'box',
        center: [0.1, 0.2, 0],
        halfExtents: [0, 1, 1],
        rotationY: 0.4,
        rounding: 0,
      }),
    ).toThrow(/decor "decor:p2": halfExtents/);
  });

  it('measures exact distances to spheres, boxes and capsules', () => {
    const sphere = compileCollider({
      id: 's',
      hard: true,
      kind: 'sphere',
      center: [0, 0.2, 0],
      radius: 0.1,
    });
    expect(sphere.sample(0, 0.35, 0, n)).toBeCloseTo(0.05, 12);
    expect(Array.from(n)).toEqual([0, 1, 0]);
    expect(sphere.sample(0.05, 0.2, 0, n)).toBeCloseTo(-0.05, 12);

    const box = compileCollider({
      id: 'b',
      hard: true,
      kind: 'box',
      center: [0, 0.1, 0],
      halfExtents: [0.2, 0.05, 0.05],
      rotationY: 0,
      rounding: 0,
    });
    expect(box.sample(0.1, 0.1, 0, n)).toBeCloseTo(-0.05, 12);
    expect(box.sample(0.3, 0.1, 0, n)).toBeCloseTo(0.1, 12);
    expect(at(n, 0)).toBeCloseTo(1, 12);

    const turned = compileCollider({
      id: 't',
      hard: true,
      kind: 'box',
      center: [0, 0.1, 0],
      halfExtents: [0.2, 0.05, 0.05],
      rotationY: Math.PI / 2,
      rounding: 0,
    });
    expect(turned.sample(0.1, 0.1, 0, n)).toBeCloseTo(0.05, 12);
    expect(turned.sample(0, 0.1, 0.1, n)).toBeCloseTo(-0.05, 12);

    const rounded = compileCollider({
      id: 'r',
      hard: true,
      kind: 'box',
      center: [0, 0, 0],
      halfExtents: [0.1, 0.1, 0.1],
      rotationY: 0,
      rounding: 0.02,
    });
    expect(rounded.sample(0.2, 0, 0, n)).toBeCloseTo(0.1, 12);
    const corner = rounded.sample(0.2, 0.2, 0, n);
    expect(corner).toBeCloseTo(Math.hypot(0.12, 0.12) - 0.02, 12);

    const capsule = compileCollider({
      id: 'c',
      hard: false,
      kind: 'capsule',
      a: [0, 0, 0],
      b: [0, 0.2, 0],
      radius: 0.03,
    });
    expect(capsule.sample(0.1, 0.1, 0, n)).toBeCloseTo(0.07, 12);
    expect(Array.from(n)).toEqual([1, 0, 0]);
    expect(capsule.sample(0, 0.3, 0, n)).toBeCloseTo(0.07, 12);
  });

  it('measures a hull as its k-DOP: exact inside, never beyond the true distance outside', () => {
    const corners: [number, number, number][] = [];
    for (const x of [-0.1, 0.1]) {
      for (const y of [0.1, 0.3]) for (const z of [-0.05, 0.05]) corners.push([x, y, z]);
    }
    const hull = compileCollider({ id: 'h', hard: true, kind: 'hull', vertices: corners });
    const box = compileCollider({
      id: 'b',
      hard: true,
      kind: 'box',
      center: [0, 0.2, 0],
      halfExtents: [0.1, 0.1, 0.05],
      rotationY: 0,
      rounding: 0,
    });
    const rng = new Rng(11);
    for (let k = 0; k < 2000; k++) {
      const x = rng.signed() * 0.3;
      const y = rng.range(-0.1, 0.5);
      const z = rng.signed() * 0.3;
      const dh = hull.sample(x, y, z, n);
      const db = box.sample(x, y, z, m);
      if (db <= 0) {
        expect(dh).toBeCloseTo(db, 12);
      } else {
        expect(dh).toBeGreaterThan(0);
        expect(dh).toBeLessThanOrEqual(db + 1e-12);
      }
      expect(Math.hypot(at(n, 0), at(n, 1), at(n, 2))).toBeCloseTo(1, 12);
    }
    expect(hull.sample(0, 0.2, 0.2, n)).toBeCloseTo(0.15, 12);
    expect(Array.from(n)).toEqual([0, 0, 1]);
  });

  it('evaluates a hull with the shared k-DOP planes, with their bounding box as its bounds', () => {
    const rng = new Rng(5);
    const vertices: [number, number, number][] = Array.from({ length: 40 }, () => [
      rng.signed() * 0.2,
      rng.range(0, 0.3),
      rng.signed() * 0.1,
    ]);
    const hull = compileCollider({ id: 'h', hard: true, kind: 'hull', vertices });
    const planes = fitHullPlanes(vertices.flat());
    expect([hull.maxX, -hull.minX, hull.maxY, -hull.minY, hull.maxZ, -hull.minZ]).toEqual(
      [0, 1, 2, 3, 4, 5].map((k) => at(planes, k * 4 + 3)),
    );
    for (let s = 0; s < 500; s++) {
      const [x, y, z] = [rng.signed() * 0.4, rng.range(-0.1, 0.4), rng.signed() * 0.3];
      let expected = -Infinity;
      for (let k = 0; k < planes.length; k += 4) {
        expected = Math.max(
          expected,
          at(planes, k) * x + at(planes, k + 1) * y + at(planes, k + 2) * z - at(planes, k + 3),
        );
      }
      expect(hull.sample(x, y, z, n)).toBe(expected);
    }
  });

  it('rejects malformed colliders with the collider id and the bad field in the message', () => {
    const bad: { collider: Collider; field: string }[] = [
      {
        collider: { id: 'neg', hard: true, kind: 'sphere', center: [0, 0, 0], radius: -1 },
        field: 'radius',
      },
      {
        collider: { id: 'nan', hard: true, kind: 'sphere', center: [Number.NaN, 0, 0], radius: 1 },
        field: 'center.0',
      },
      {
        collider: {
          id: 'round',
          hard: true,
          kind: 'box',
          center: [0, 0, 0],
          halfExtents: [0.1, 0.1, 0.1],
          rotationY: 0,
          rounding: 0.2,
        },
        field: 'rounding',
      },
      {
        collider: {
          id: 'flat',
          hard: true,
          kind: 'box',
          center: [0, 0, 0],
          halfExtents: [0.1, 0, 0.1],
          rotationY: 0,
          rounding: 0,
        },
        field: 'halfExtents.1',
      },
      {
        collider: {
          id: 'inf',
          hard: true,
          kind: 'capsule',
          a: [0, 0, 0],
          b: [0, Infinity, 0],
          radius: 0.1,
        },
        field: 'b.1',
      },
      {
        collider: {
          id: 'sheet',
          hard: true,
          kind: 'hull',
          vertices: [
            [0, 0, 0],
            [1, 0, 0],
            [0, 0, 1],
            [1, 0, 1],
          ],
        },
        field: 'vertices',
      },
    ];
    for (const { collider, field } of bad) {
      expect(() => compileCollider(collider)).toThrow(`decor "${collider.id}": ${field}`);
    }
  });

  it('rejects colliders that only a bad cast or a corrupt message could produce', () => {
    // The bridge receives decor from the main thread, where the types are only a promise.
    const forged = (value: unknown): Collider => value as Collider;
    expect(() =>
      compileCollider(forged({ id: 'cone', hard: true, kind: 'cone', radius: 1 })),
    ).toThrow(/decor "cone": kind/);
    expect(() =>
      compileCollider(
        forged({ id: 7, hard: true, kind: 'sphere', center: [0, 0, 0], radius: 0.1 }),
      ),
    ).toThrow(/decor 7: id/);
    expect(() =>
      compileCollider(
        forged({ id: 'maybe', hard: 'yes', kind: 'sphere', center: [0, 0, 0], radius: 0.1 }),
      ),
    ).toThrow(/decor "maybe": hard/);
    expect(() =>
      compileCollider(
        forged({
          id: 'old',
          solid: true,
          shape: { kind: 'sphere', center: [0, 0, 0], radius: 0.1 },
        }),
      ),
    ).toThrow(/decor "old": kind/);
    expect(() => compileCollider(forged({ id: 'flat', solid: true, shape: null }))).toThrow(
      /decor "flat"/,
    );
    expect(() => compileCollider(forged(null))).toThrow(/decor \(no id\)/);
  });
});

describe('DecorField', () => {
  it('matches a brute-force union of its colliders within reach', () => {
    const field = new DecorField(REEF_TANK, 0.15);
    field.set(REEF_DECOR);
    const brute = bruteForce(REEF_DECOR, 0.15);
    expectSameField((x, y, z, o) => field.sample(x, y, z, o), brute, REEF_TANK, 1);
  });

  it('reports the reach, not a nearer distance, where no collider is close', () => {
    const field = new DecorField(REEF_TANK, 0.1);
    field.set([{ id: 's', hard: true, kind: 'sphere', center: [0, 0.3, 0], radius: 0.05 }]);
    expect(field.sample(0.6, 0.3, 0, n)).toBe(0.1);
    expect(field.sample(0, 0.3, 0.12, n)).toBeCloseTo(0.07, 12);
  });

  it('rebuilds only what changed and ends equal to a fresh build', () => {
    const field = new DecorField(REEF_TANK, 0.15);
    const full = field.set(REEF_DECOR);
    expect(full).toBeGreaterThan(0);
    expect(field.set(REEF_DECOR)).toBe(0);
    expect(field.set(REEF_DECOR.map((c) => structuredClone(c)))).toBe(0);

    const moved: Collider[] = REEF_DECOR.map((c) =>
      c.id === 'cave-west'
        ? { id: c.id, hard: c.hard, kind: 'sphere', center: [-0.3, 0.1, 0.1], radius: 0.05 }
        : c,
    );
    const touched = field.set(moved);
    expect(touched).toBeGreaterThan(0);
    expect(touched).toBeLessThan(full / 2);

    const fresh = new DecorField(REEF_TANK, 0.15);
    fresh.set(moved);
    expectSameField(
      (x, y, z, o) => field.sample(x, y, z, o),
      (x, y, z, o) => fresh.sample(x, y, z, o),
      REEF_TANK,
      2,
    );

    const fewer = moved.filter((c) => c.id !== 'rock-left');
    expect(field.set(fewer)).toBeGreaterThan(0);
    expect(field.has('rock-left')).toBe(false);
    expect(field.size).toBe(fewer.length);
    expectSameField(
      (x, y, z, o) => field.sample(x, y, z, o),
      bruteForce(fewer, 0.15),
      REEF_TANK,
      3,
    );
  });

  it('takes a widened reach back to exactly the field a fresh build gives', () => {
    const field = new DecorField(REEF_TANK, 0.1);
    field.set(REEF_DECOR);
    const fresh = new DecorField(REEF_TANK, 0.1);
    fresh.set(REEF_DECOR);

    expect(field.widen(0.25)).toBeGreaterThan(0);
    expect(field.cellEntries).toBeGreaterThan(fresh.cellEntries);
    expect(field.restoreReach(0.1)).toBeGreaterThan(0);
    expect(field.reach).toBe(0.1);
    // Samples clamp at the reach, so stale wide-reach entries would only show up as extra work.
    expect(field.cellEntries).toBe(fresh.cellEntries);
    expectSameField(
      (x, y, z, o) => field.sample(x, y, z, o),
      (x, y, z, o) => fresh.sample(x, y, z, o),
      REEF_TANK,
      4,
    );
    expect(field.restoreReach(0.1)).toBe(0);
  });

  it('fails loudly on duplicate ids, unknown removals and a bad reach', () => {
    const field = new DecorField(SHOW_TANK, 0.1);
    const stone = SHOW_DECOR.find((c) => c.id === 'stone');
    if (!stone) throw new Error('fixture lost its stone');
    expect(() => field.set([stone, stone])).toThrow('unique');
    expect(() => field.remove(['ghost'])).toThrow('"ghost"');
    expect(() => new DecorField(SHOW_TANK, 0)).toThrow('reach');
    expect(() => new DecorField(SHOW_TANK, Number.NaN)).toThrow('reach');
  });

  it('leaves the field untouched when any collider in an update is bad', () => {
    const field = new DecorField(SHOW_TANK, 0.1);
    const stone = SHOW_DECOR.find((c) => c.id === 'stone');
    if (!stone) throw new Error('fixture lost its stone');
    field.set([stone]);
    const before = field.sample(0.35, 0.15, 0.05, n);
    const moved: Collider = { ...stone, kind: 'sphere', center: [-0.35, 0, 0.05], radius: 0.12 };
    const bad: Collider = { id: 'bad', hard: true, kind: 'sphere', center: [0, 0, 0], radius: -1 };
    expect(() => field.upsert([moved, bad])).toThrow('decor "bad"');
    expect(() => field.set([moved, bad])).toThrow('decor "bad"');
    expect(field.sample(0.35, 0.15, 0.05, n)).toBe(before);
    // The rejected update must not have been remembered as applied.
    expect(field.upsert([moved])).toBeGreaterThan(0);
    expect(field.sample(0.35, 0.15, 0.05, n)).toBeGreaterThan(before);
  });

  it('unions with the tank walls by nearest surface', () => {
    const field = new DecorField(SHOW_TANK, 0.2);
    field.set([{ id: 's', hard: true, kind: 'sphere', center: [0, 0.25, 0], radius: 0.05 }]);
    const scene = new UnionSdf([new TankSdf(SHOW_TANK), field]);
    expect(scene.sample(0, 0.25, 0.1, n)).toBeCloseTo(0.05, 12);
    expect(at(n, 2)).toBeCloseTo(1, 12);
    expect(scene.sample(0.58, 0.25, 0, n)).toBeCloseTo(0.02, 12);
    expect(at(n, 0)).toBeCloseTo(-1, 12);
  });
});

describe('World decor', () => {
  function settled(decor: readonly Collider[]): World {
    const w = new World({
      seed: 4,
      tank: SHOW_TANK,
      species: ARCHETYPES,
      decor,
      fish: spawnMany('neon-tetra', 12),
    });
    for (let t = 0; t < 300; t++) w.step();
    return w;
  }

  function mostCentral(w: World): number {
    let best = 0;
    let room = -Infinity;
    for (let i = 0; i < w.count; i++) {
      const d = w.sceneSdf.sample(
        at(w.position, i * 3),
        at(w.position, i * 3 + 1),
        at(w.position, i * 3 + 2),
        n,
      );
      if (d > room) {
        room = d;
        best = i;
      }
    }
    return best;
  }

  it('sets a fish a rock is dropped onto down in free water at once', () => {
    const w = settled([]);
    const i = mostCentral(w);
    const o = i * 3;
    const rock: Collider = {
      id: 'dropped',
      hard: true,
      kind: 'sphere',
      center: [at(w.position, o) + 0.005, at(w.position, o + 1), at(w.position, o + 2)],
      radius: 0.03,
    };
    const stone = compileCollider(rock);
    expect(
      stone.sample(at(w.position, o), at(w.position, o + 1), at(w.position, o + 2), n),
    ).toBeLessThan(0);
    expect(w.setDecor([rock])).toBeGreaterThan(0);
    for (let k = 0; k < w.count; k++) {
      expect(w.bodyClearance(k)).toBeGreaterThanOrEqual(-PENETRATION_EPSILON);
    }
    for (let t = 0; t < 600; t++) {
      w.step();
      for (let k = 0; k < w.count; k++) {
        expect(w.bodyClearance(k)).toBeGreaterThanOrEqual(-PENETRATION_EPSILON);
      }
    }
  });

  describe('a rock moved across the tank', () => {
    const rockAt = (x: number): Collider => ({
      id: 'rock',
      hard: true,
      kind: 'box',
      center: [x, 0.1, 0],
      halfExtents: [0.12, 0.1, 0.12],
      rotationY: 0,
      rounding: 0.02,
    });
    const OLD = compileCollider(rockAt(-0.3));
    const NEW = compileCollider(rockAt(0.3));

    function community(seed: number): World {
      const w = new World({
        seed,
        tank: SHOW_TANK,
        species: [neonTetra, bronzeCorydoras, cherryShrimp, angelfish],
        decor: [rockAt(-0.3)],
        fish: [
          ...spawnMany(neonTetra.id, 12),
          ...spawnMany(bronzeCorydoras.id, 4),
          ...spawnMany(cherryShrimp.id, 8),
          ...spawnMany(angelfish.id, 2),
        ],
      });
      for (let t = 0; t < 900; t++) w.step();
      return w;
    }

    const centre = (w: World, field: typeof OLD, k: number): number =>
      field.sample(at(w.position, k * 3), at(w.position, k * 3 + 1), at(w.position, k * 3 + 2), n);

    it('keeps every body, sand dwellers under it included, out of the new place', () => {
      for (const seed of [1, 2, 3]) {
        const w = community(seed);
        const underNew = [];
        for (let k = 0; k < w.count; k++) if (centre(w, NEW, k) < 0) underNew.push(k);
        expect(
          underNew.length,
          `seed ${seed}: some fish sit where the rock will land`,
        ).toBeGreaterThan(0);
        w.setDecor([rockAt(0.3)]);
        for (let t = 0; t <= 900; t++) {
          for (let k = 0; k < w.count; k++) {
            expect(
              w.bodyClearance(k),
              `seed ${seed} step ${t} ${w.fishIds[k]}`,
            ).toBeGreaterThanOrEqual(-PENETRATION_EPSILON);
          }
          w.step();
        }
      }
    });

    it('lets fish into the space the rock left', () => {
      const w = community(1);
      w.setDecor([rockAt(0.3)]);
      let visits = 0;
      for (let t = 0; t < 1800; t++) {
        w.step();
        for (let k = 0; k < w.count; k++) if (centre(w, OLD, k) < 0) visits++;
      }
      expect(visits).toBeGreaterThan(0);
    });

    it('stands walkers caught under it back on a surface', () => {
      const w = community(1);
      const caught = [];
      for (let k = 0; k < w.count; k++) {
        if (w.fishIds[k]?.startsWith(cherryShrimp.id) && centre(w, NEW, k) < 0.02) caught.push(k);
      }
      expect(caught.length).toBeGreaterThan(0);
      w.setDecor([rockAt(0.3)]);
      for (const k of caught) {
        expect(w.bodyClearance(k)).toBeGreaterThanOrEqual(-PENETRATION_EPSILON);
        expect(w.walkers.attached[k]).toBe(1);
      }
    });

    it('frees two fish a rock lands on at once, each to a place of its own', () => {
      const w = community(1);
      let pair: [number, number] = [0, 1];
      let closest = Infinity;
      for (let k = 0; k < w.count; k++) {
        for (let j = k + 1; j < w.count; j++) {
          const d = Math.hypot(
            ...[0, 1, 2].map((c) => at(w.position, k * 3 + c) - at(w.position, j * 3 + c)),
          );
          if (d < closest) {
            closest = d;
            pair = [k, j];
          }
        }
      }
      const [k, j] = pair;
      const lo = [0, 1, 2].map((c) =>
        Math.min(at(w.position, k * 3 + c), at(w.position, j * 3 + c)),
      );
      const hi = [0, 1, 2].map((c) =>
        Math.max(at(w.position, k * 3 + c), at(w.position, j * 3 + c)),
      );
      const ground = 0;
      const top = (hi[1] ?? 0) + 0.04;
      const dropped: Collider = {
        id: 'dropped',
        hard: true,
        kind: 'box',
        center: [
          ((lo[0] ?? 0) + (hi[0] ?? 0)) / 2,
          (ground + top) / 2,
          ((lo[2] ?? 0) + (hi[2] ?? 0)) / 2,
        ],
        halfExtents: [
          ((hi[0] ?? 0) - (lo[0] ?? 0)) / 2 + 0.04,
          (top - ground) / 2,
          ((hi[2] ?? 0) - (lo[2] ?? 0)) / 2 + 0.04,
        ],
        rotationY: 0,
        rounding: 0,
      };
      const field = compileCollider(dropped);
      expect(centre(w, field, k)).toBeLessThan(0);
      expect(centre(w, field, j)).toBeLessThan(0);

      w.setDecor([rockAt(-0.3), dropped]);

      for (const f of [k, j]) {
        expect(w.bodyClearance(f), w.fishIds[f]).toBeGreaterThanOrEqual(-PENETRATION_EPSILON);
        expect(centre(w, field, f)).toBeGreaterThan(0);
      }
      const apart = Math.hypot(
        ...[0, 1, 2].map((c) => at(w.position, k * 3 + c) - at(w.position, j * 3 + c)),
      );
      expect(apart).toBeGreaterThan(0.01);
    });

    it('moves the same way from the same seed', () => {
      const [a, b] = [community(2), community(2)];
      for (const w of [a, b]) {
        w.setDecor([rockAt(0.3)]);
        for (let t = 0; t < 300; t++) w.step();
      }
      expect(Array.from(a.position)).toEqual(Array.from(b.position));
    });
  });

  it('lets fish brush through plants without counting them as hard contacts', () => {
    const w = settled([]);
    const i = mostCentral(w);
    const o = i * 3;
    const x = at(w.position, o);
    const z = at(w.position, o + 2);
    const plant: Collider = {
      id: 'reed',
      hard: false,
      kind: 'capsule',
      a: [x, 0, z],
      b: [x, SHOW_TANK.height * 0.9, z],
      radius: 0.02,
    };
    const reed = compileCollider(plant);
    const contactsBefore = w.contacts;
    expect(w.setDecor([plant])).toBeGreaterThan(0);
    expect(w.decorSdf).toBeNull();
    let inside = 0;
    for (let t = 0; t < 600; t++) {
      w.step();
      for (let k = 0; k < w.count; k++) {
        if (
          reed.sample(
            at(w.position, k * 3),
            at(w.position, k * 3 + 1),
            at(w.position, k * 3 + 2),
            n,
          ) < 0
        )
          inside++;
      }
    }
    expect(w.plantContacts).toBeGreaterThan(0);
    expect(inside).toBeGreaterThan(0);
    expect(w.contacts - contactsBefore).toBeLessThan(w.count * 600 * 1e-3);
  });

  it('rejects duplicate collider ids', () => {
    const w = settled([]);
    expect(() => w.setDecor([...SHOW_DECOR, ...SHOW_DECOR.slice(0, 1)])).toThrow('unique');
  });

  it('applies a decor update all or nothing', () => {
    const w = settled(SHOW_DECOR);
    const probe = (): number => w.sceneSdf.sample(0.35, 0.15, 0.05, n);
    const before = probe();
    const rest = SHOW_DECOR.filter((c) => c.id !== 'stone');
    const badPlant: Collider = {
      id: 'bad-plant',
      hard: false,
      kind: 'capsule',
      a: [0, 0, 0],
      b: [0, Number.NaN, 0],
      radius: 0.02,
    };
    expect(() => w.setDecor([...rest, badPlant])).toThrow('decor "bad-plant"');
    expect(probe()).toBe(before);
    expect(w.setDecor(rest)).toBeGreaterThan(0);
    expect(probe()).toBeGreaterThan(before);
  });
});
