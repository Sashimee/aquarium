import { describe, expect, it } from 'vitest';
import { compileCollider, DecorField, UnionSdf, type DecorCollider } from './decor.ts';
import { ARCHETYPES, REEF_DECOR, REEF_TANK, SHOW_DECOR, SHOW_TANK, spawnMany } from './fixtures.ts';
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

function bruteForce(colliders: readonly DecorCollider[], reach: number) {
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
  it('measures exact distances to spheres, boxes and capsules', () => {
    const sphere = compileCollider({
      id: 's',
      solid: true,
      shape: { kind: 'sphere', center: [0, 0.2, 0], radius: 0.1 },
    });
    expect(sphere.sample(0, 0.35, 0, n)).toBeCloseTo(0.05, 12);
    expect(Array.from(n)).toEqual([0, 1, 0]);
    expect(sphere.sample(0.05, 0.2, 0, n)).toBeCloseTo(-0.05, 12);

    const box = compileCollider({
      id: 'b',
      solid: true,
      shape: { kind: 'box', center: [0, 0.1, 0], halfExtents: [0.2, 0.05, 0.05] },
    });
    expect(box.sample(0.1, 0.1, 0, n)).toBeCloseTo(-0.05, 12);
    expect(box.sample(0.3, 0.1, 0, n)).toBeCloseTo(0.1, 12);
    expect(at(n, 0)).toBeCloseTo(1, 12);

    const turned = compileCollider({
      id: 't',
      solid: true,
      shape: {
        kind: 'box',
        center: [0, 0.1, 0],
        halfExtents: [0.2, 0.05, 0.05],
        rotationY: Math.PI / 2,
      },
    });
    expect(turned.sample(0.1, 0.1, 0, n)).toBeCloseTo(0.05, 12);
    expect(turned.sample(0, 0.1, 0.1, n)).toBeCloseTo(-0.05, 12);

    const rounded = compileCollider({
      id: 'r',
      solid: true,
      shape: { kind: 'box', center: [0, 0, 0], halfExtents: [0.1, 0.1, 0.1], rounding: 0.02 },
    });
    expect(rounded.sample(0.2, 0, 0, n)).toBeCloseTo(0.1, 12);
    const corner = rounded.sample(0.2, 0.2, 0, n);
    expect(corner).toBeCloseTo(Math.hypot(0.12, 0.12) - 0.02, 12);

    const capsule = compileCollider({
      id: 'c',
      solid: false,
      shape: { kind: 'capsule', a: [0, 0, 0], b: [0, 0.2, 0], radius: 0.03 },
    });
    expect(capsule.sample(0.1, 0.1, 0, n)).toBeCloseTo(0.07, 12);
    expect(Array.from(n)).toEqual([1, 0, 0]);
    expect(capsule.sample(0, 0.3, 0, n)).toBeCloseTo(0.07, 12);
  });

  it('rejects malformed shapes with the collider id in the message', () => {
    const bad: DecorCollider[] = [
      { id: 'neg', solid: true, shape: { kind: 'sphere', center: [0, 0, 0], radius: -1 } },
      { id: 'nan', solid: true, shape: { kind: 'sphere', center: [Number.NaN, 0, 0], radius: 1 } },
      {
        id: 'round',
        solid: true,
        shape: { kind: 'box', center: [0, 0, 0], halfExtents: [0.1, 0.1, 0.1], rounding: 0.2 },
      },
      {
        id: 'flat',
        solid: true,
        shape: { kind: 'box', center: [0, 0, 0], halfExtents: [0.1, 0, 0.1] },
      },
      {
        id: 'inf',
        solid: true,
        shape: { kind: 'capsule', a: [0, 0, 0], b: [0, Infinity, 0], radius: 0.1 },
      },
    ];
    for (const c of bad) expect(() => compileCollider(c)).toThrow(`decor "${c.id}"`);
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
    field.set([
      { id: 's', solid: true, shape: { kind: 'sphere', center: [0, 0.3, 0], radius: 0.05 } },
    ]);
    expect(field.sample(0.6, 0.3, 0, n)).toBe(0.1);
    expect(field.sample(0, 0.3, 0.12, n)).toBeCloseTo(0.07, 12);
  });

  it('rebuilds only what changed and ends equal to a fresh build', () => {
    const field = new DecorField(REEF_TANK, 0.15);
    const full = field.set(REEF_DECOR);
    expect(full).toBeGreaterThan(0);
    expect(field.set(REEF_DECOR)).toBe(0);
    expect(field.set(REEF_DECOR.map((c) => ({ ...c, shape: { ...c.shape } })))).toBe(0);

    const moved = REEF_DECOR.map((c) =>
      c.id === 'cave-west'
        ? {
            ...c,
            shape: { kind: 'sphere' as const, center: [-0.3, 0.1, 0.1] as const, radius: 0.05 },
          }
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

  it('fails loudly on duplicate ids, unknown removals and a bad reach', () => {
    const field = new DecorField(SHOW_TANK, 0.1);
    const stone = SHOW_DECOR.find((c) => c.id === 'stone');
    if (!stone) throw new Error('fixture lost its stone');
    expect(() => field.set([stone, stone])).toThrow('unique');
    expect(() => field.remove(['ghost'])).toThrow('"ghost"');
    expect(() => new DecorField(SHOW_TANK, 0)).toThrow('reach');
    expect(() => new DecorField(SHOW_TANK, Number.NaN)).toThrow('reach');
  });

  it('unions with the tank walls by nearest surface', () => {
    const field = new DecorField(SHOW_TANK, 0.2);
    field.set([
      { id: 's', solid: true, shape: { kind: 'sphere', center: [0, 0.25, 0], radius: 0.05 } },
    ]);
    const scene = new UnionSdf([new TankSdf(SHOW_TANK), field]);
    expect(scene.sample(0, 0.25, 0.1, n)).toBeCloseTo(0.05, 12);
    expect(at(n, 2)).toBeCloseTo(1, 12);
    expect(scene.sample(0.58, 0.25, 0, n)).toBeCloseTo(0.02, 12);
    expect(at(n, 0)).toBeCloseTo(-1, 12);
  });
});

describe('World decor', () => {
  function settled(decor: readonly DecorCollider[]): World {
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

  it('pushes a fish out of a rock dropped onto it, on the next step', () => {
    const w = settled([]);
    const i = mostCentral(w);
    const o = i * 3;
    const rock: DecorCollider = {
      id: 'dropped',
      solid: true,
      shape: {
        kind: 'sphere',
        center: [at(w.position, o) + 0.005, at(w.position, o + 1), at(w.position, o + 2)],
        radius: 0.03,
      },
    };
    expect(w.setDecor([rock])).toBeGreaterThan(0);
    expect(w.bodyClearance(i)).toBeLessThan(0);
    w.step();
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

  it('lets fish brush through plants without counting them as hard contacts', () => {
    const w = settled([]);
    const i = mostCentral(w);
    const o = i * 3;
    const x = at(w.position, o);
    const z = at(w.position, o + 2);
    const plant: DecorCollider = {
      id: 'reed',
      solid: false,
      shape: { kind: 'capsule', a: [x, 0, z], b: [x, SHOW_TANK.height * 0.9, z], radius: 0.02 },
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
});
