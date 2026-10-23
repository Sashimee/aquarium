import { describe, expect, it } from 'vitest';
import { colliderListSchema, fitHullPlanes, type Collider } from '@aquarium/shared';
import { Rng, World } from '@aquarium/sim';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { substrateHeight } from '../engine/tank/substrate';
import {
  ColliderField,
  fitHull,
  type Collider as SceneCollider,
  type HullCollider,
} from '../scene/colliders';
import { demoTank } from './demoStock';
import { colliderDigest, hullCorners, SimColliders, sceneCollidersToSim } from './simColliders';

/** An irregular rock: points on a squashed, lumpy ellipsoid resting on the sand at (x, z). */
function rockPoints(x: number, z: number, seed: number): number[] {
  const rng = new Rng(seed);
  const base = substrateHeight(DEFAULT_TANK, x, z) - 0.01;
  const points: number[] = [];
  for (let i = 0; i < 40; i++) {
    const theta = rng.next() * Math.PI * 2;
    const up = rng.next();
    const r = Math.sqrt(1 - up * up);
    const lump = 1 + 0.25 * rng.signed();
    points.push(
      x + 0.09 * lump * r * Math.cos(theta),
      base + 0.11 * lump * up,
      z + 0.06 * lump * r * Math.sin(theta),
    );
  }
  points.push(x, base, z);
  return points;
}

function rock(x: number, z: number, seed: number): HullCollider {
  return fitHull(rockPoints(x, z, seed));
}

const PLANT: SceneCollider = {
  kind: 'capsule',
  hard: false,
  a: [0.3, 0.1, -0.1],
  b: [0.3, 0.3, -0.1],
  radius: 0.03,
};

describe('hullCorners', () => {
  it('finds the eight corners of a box k-DOP', () => {
    const box: number[] = [];
    for (const x of [-0.1, 0.2])
      for (const y of [0.05, 0.15])
        for (const z of [-0.3, 0.1]) {
          box.push(x, y, z);
        }
    const corners = hullCorners(fitHull(box).planes);
    expect(corners).toHaveLength(8);
    for (const c of corners) {
      const match = [0, 1, 2, 3, 4, 5, 6, 7].some(
        (i) =>
          Math.hypot(
            c[0] - (box[i * 3] ?? 0),
            c[1] - (box[i * 3 + 1] ?? 0),
            c[2] - (box[i * 3 + 2] ?? 0),
          ) < 1e-9,
      );
      expect(match, c.join(', ')).toBe(true);
    }
  });

  it('gives corners from which the sim rebuilds the scene planes', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const hull = rock(0.1 * seed - 0.3, 0, seed);
      const corners = hullCorners(hull.planes);
      expect(corners.length).toBeGreaterThanOrEqual(4);
      expect(corners.length).toBeLessThanOrEqual(2 * (hull.planes.length / 4) - 4);
      const rebuilt = fitHullPlanes(corners.flat());
      expect(rebuilt).toHaveLength(hull.planes.length);
      hull.planes.forEach((v, i) => expect(rebuilt[i], `plane value ${i}`).toBeCloseTo(v, 9));
    }
  });

  it('returns nothing for planes that enclose no volume', () => {
    expect(
      hullCorners([1, 0, 0, -1, -1, 0, 0, -1, 0, 1, 0, 1, 0, -1, 0, 1, 0, 0, 1, 1, 0, 0, -1, 1]),
    ).toEqual([]);
  });
});

describe('sceneCollidersToSim', () => {
  it('keeps order, hardness and capsule fields, with ids the shared contract accepts', () => {
    const hull = rock(0, 0, 3);
    const out = sceneCollidersToSim([hull, PLANT]);
    expect(out.map((c) => [c.id, c.kind, c.hard])).toEqual([
      ['scene:0', 'hull', true],
      ['scene:1', 'capsule', false],
    ]);
    expect(out[1]).toEqual({ id: 'scene:1', ...PLANT });
    expect(colliderListSchema.safeParse(out).success).toBe(true);
  });

  it('leaves out a flat leaf card the contract has no shape for, keeping the others’ ids', () => {
    const card: number[] = [];
    for (const [x, z] of [
      [-0.05, -0.02],
      [0.04, -0.03],
      [0.06, 0.03],
      [-0.03, 0.04],
    ] as const) {
      card.push(x, 0.02, z);
    }
    const leaf = fitHull(card);
    expect(hullCorners(leaf.planes).length).toBeGreaterThan(0);
    expect(
      colliderListSchema.safeParse([
        { id: 'leaf', kind: 'hull', hard: true, vertices: hullCorners(leaf.planes) },
      ]).success,
    ).toBe(false);
    const out = sceneCollidersToSim([rock(-0.2, 0, 1), leaf, PLANT]);
    expect(out.map((c) => c.id)).toEqual(['scene:0', 'scene:2']);
    expect(colliderListSchema.safeParse(out).success).toBe(true);
  });
});

describe('SimColliders', () => {
  const decorBox: Collider = {
    id: 'decor:p1',
    hard: true,
    kind: 'box',
    center: [0, 0.12, 0],
    halfExtents: [0.05, 0.04, 0.05],
    rotationY: 0,
    rounding: 0,
  };

  it("swaps the scene's hardscape for the decor layer's pieces and keeps the plants", () => {
    const colliders = new SimColliders();
    expect(colliders.list).toEqual([]);
    const scene = colliders.setScene([rock(0, 0, 1), PLANT]);
    expect(scene.map((c) => c.id)).toEqual(['scene:1', 'scene:0']);
    const decor = colliders.setDecor([decorBox]);
    expect(decor.map((c) => c.id)).toEqual(['scene:1', 'decor:p1']);
    expect(decor[1]).toEqual({
      id: 'decor:p1',
      hard: true,
      kind: 'box',
      center: [0, 0.12, 0],
      halfExtents: [0.05, 0.04, 0.05],
      rotationY: 0,
      rounding: 0,
    });
    expect(colliders.list).toBe(decor);
  });

  it("drops the last scene's decor pieces when a new scene mounts", () => {
    const colliders = new SimColliders();
    colliders.setScene([PLANT]);
    colliders.setDecor([decorBox]);
    expect(colliders.setScene([]).map((c) => c.id)).toEqual([]);
    expect(colliders.setDecor([]).map((c) => c.id)).toEqual([]);
  });

  it('throws on a broken list and keeps the last valid one', () => {
    const colliders = new SimColliders();
    const before = colliders.setScene([PLANT]);
    const twice = [decorBox, decorBox];
    expect(() => colliders.setDecor(twice)).toThrow(/decor:p1.*repeats/);
    expect(colliders.list).toBe(before);
    expect(colliders.setDecor([decorBox]).map((c) => c.id)).toEqual(['scene:0', 'decor:p1']);
  });

  it("drops the old tank's colliders when the new scene's are broken", () => {
    const colliders = new SimColliders();
    colliders.setScene([PLANT, rock(0, 0, 1)]);
    const empty: SceneCollider = {
      kind: 'hull',
      hard: true,
      planes: [1, 0, 0, -1, -1, 0, 0, -1, 0, 1, 0, 1, 0, -1, 0, 1, 0, 0, 1, 1, 0, 0, -1, 1],
      centre: [0, 0, 0],
      boundRadius: 1,
    };
    expect(() => colliders.setScene([PLANT, empty])).toThrow(/Sim colliders are invalid/);
    expect(colliders.list).toEqual([]);
    expect(colliders.setDecor([decorBox]).map((c) => c.id)).toEqual(['decor:p1']);
  });
});

describe('colliderDigest', () => {
  const box = (id: string, x: number): Collider => ({
    id,
    hard: true,
    kind: 'box',
    center: [x, 0.1, 0],
    halfExtents: [0.05, 0.05, 0.05],
    rotationY: 0,
    rounding: 0,
  });
  const reed: Collider = {
    id: 'decor:reed',
    hard: false,
    kind: 'capsule',
    a: [0, 0, 0],
    b: [0, 0.3, 0],
    radius: 0.02,
  };

  it('lists every piece by id with where it sits', () => {
    expect(colliderDigest([box('decor:b', 0.2), reed, box('decor:a', -0.1)])).toBe(
      'decor:a@-0.100,0.100,0.000 decor:b@0.200,0.100,0.000 decor:reed@0.000,0.150,0.000',
    );
  });

  it('changes when a piece moves and centres capsules and hulls', () => {
    expect(colliderDigest([box('decor:a', 0)])).not.toBe(colliderDigest([box('decor:a', 0.01)]));
    const log: Collider = {
      ...reed,
      id: 'decor:log',
      hard: true,
      a: [0, 0.1, 0],
      b: [0.2, 0.1, 0],
    };
    const tetra: Collider = {
      id: 'scene:0',
      hard: true,
      kind: 'hull',
      vertices: [
        [0, 0, 0],
        [0.4, 0, 0],
        [0, 0.4, 0],
        [0, 0, 0.4],
      ],
    };
    expect(colliderDigest([log, tetra])).toBe(
      'decor:log@0.100,0.100,0.000 scene:0@0.100,0.100,0.100',
    );
    expect(colliderDigest([])).toBe('');
  });
});

// Seconds of CPU-bound simulation: a 5 s default times out when the full suite saturates the cores.
const LONG = 60_000;

describe('demo sim with scene hull colliders', { timeout: LONG }, () => {
  const rocks = [rock(-0.2, -0.08, 21), rock(0.15, 0.02, 22), rock(0.35, -0.12, 23)];
  const field = new ColliderField(rocks);
  const normal = new Float64Array(3);

  function world(decor: readonly Collider[]): World {
    return new World({ ...demoTank(DEFAULT_TANK, 4, 'freshwater').config, decor });
  }

  function insideCount(decor: readonly Collider[], steps: number) {
    const w = world(decor);
    let inside = 0;
    let near = 0;
    let clearance = Infinity;
    for (let step = 0; step < steps; step++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        const d = field.hard(
          w.position[i * 3] ?? 0,
          w.position[i * 3 + 1] ?? 0,
          w.position[i * 3 + 2] ?? 0,
          normal,
        );
        clearance = Math.min(clearance, d - (w.thickness[i] ?? 0), w.bodyClearance(i));
        if (d < 0) inside++;
        else if (d < 0.05) near++;
      }
    }
    return { inside, near, clearance };
  }

  it('keeps every fish out of the rocks, which they swim through without them', () => {
    const without = insideCount([], 2000);
    expect(without.inside).toBeGreaterThan(100);
    const withRocks = insideCount(sceneCollidersToSim(rocks), 6000);
    expect(withRocks.inside).toBe(0);
    expect(withRocks.clearance).toBeGreaterThan(-1e-6);
    expect(withRocks.near).toBeGreaterThan(100);
  });

  it('is deterministic with the converted colliders', () => {
    const a = world(sceneCollidersToSim(rocks));
    const b = world(sceneCollidersToSim(rocks));
    for (let step = 0; step < 1500; step++) {
      a.step();
      b.step();
    }
    expect(Array.from(b.position)).toEqual(Array.from(a.position));
    expect(Array.from(b.yaw)).toEqual(Array.from(a.yaw));
    expect(Array.from(b.speed)).toEqual(Array.from(a.speed));
  });
});
