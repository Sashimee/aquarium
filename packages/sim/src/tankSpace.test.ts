import {
  fitHullPlanes,
  sampleFloor,
  sampleFloorSlope,
  tankWaterBounds,
  type Collider,
  type TankSpace,
} from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { Basin } from './basin.ts';
import type { Point3 } from './decor.ts';
import {
  ARCHETYPES,
  bronzeCorydoras,
  FoodRain,
  neonTetra,
  SHOW_TANK,
  SLOPED_SPACE,
  spawnMany,
} from './fixtures.ts';
import type { AteEvent } from './food.ts';
import { Rng } from './rng.ts';
import { TankSdf } from './sdf.ts';
import { FishState } from './snapshot.ts';
import { World, type AnyWorldConfig } from './world.ts';

const LONG = 60_000;

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

function stateOf(w: World): Float64Array[] {
  return [w.position, w.yaw, w.pitch, w.roll, w.speed, w.yawRate, w.pitchRate].map(
    (a) => new Float64Array(a),
  );
}

/** A lumpy rock: 30 points on a squashed, jittered ellipsoid sitting in the sand. */
function rockVertices(cx: number, cz: number, base: number): [number, number, number][] {
  const rng = new Rng(21);
  return Array.from({ length: 30 }, (_, k) => {
    const y = 1 - (2 * (k + 0.5)) / 30;
    const r = Math.sqrt(1 - y * y);
    const a = k * 2.399963;
    const s = 1 + rng.signed() * 0.15;
    return [
      cx + 0.12 * s * r * Math.cos(a),
      base + 0.07 + 0.09 * s * y,
      cz + 0.08 * s * r * Math.sin(a),
    ];
  });
}

const ROCK_X = 0.12;
const ROCK_Z = -0.02;
const ROCK: Collider = {
  id: 'rock',
  hard: true,
  kind: 'hull',
  vertices: rockVertices(ROCK_X, ROCK_Z, SLOPED_SPACE.floor.min),
};

function sloped(fish: AnyWorldConfig['fish'], seed = 1, decor: readonly Collider[] = []): World {
  return new World({ seed, space: SLOPED_SPACE, species: ARCHETYPES, decor, fish });
}

describe('Basin', () => {
  it('samples the floor bit for bit like the shared TankSpace, slope included', () => {
    const basin = Basin.fromSpace(SLOPED_SPACE);
    const slope = new Float64Array(2);
    const rng = new Rng(4);
    for (let k = 0; k < 3000; k++) {
      // Reaches past the footprint on purpose: both sides clamp there.
      const x = rng.signed() * 0.7;
      const z = rng.signed() * 0.3;
      expect(basin.ground(x, z)).toBe(sampleFloor(SLOPED_SPACE, x, z));
      expect(basin.groundWithSlope(x, z, slope)).toBe(sampleFloor(SLOPED_SPACE, x, z));
      expect(Array.from(slope)).toEqual(sampleFloorSlope(SLOPED_SPACE, x, z));
    }
  });

  it('spans the shared water bounds from the lowest sand to the surface', () => {
    const basin = Basin.fromSpace(SLOPED_SPACE);
    const b = tankWaterBounds(SLOPED_SPACE);
    expect([basin.minX, basin.maxY, basin.minZ]).toEqual([b.min[0], b.max[1], b.min[2]]);
    expect([basin.maxX, basin.maxZ]).toEqual([b.max[0], b.max[2]]);
    expect(basin.minY).toBe(SLOPED_SPACE.floor.min);
    expect(basin.floorMax).toBe(SLOPED_SPACE.floor.max);
    expect(basin.ground(0, 1)).toBeCloseTo(0.05, 12);
    expect(basin.ground(0, -1)).toBeCloseTo(0.11, 12);
  });

  it('keeps the legacy box flat at y = 0', () => {
    const basin = Basin.fromTank(SHOW_TANK);
    expect([basin.minY, basin.floorMax, basin.maxY]).toEqual([0, 0, SHOW_TANK.height]);
    expect(basin.ground(0.3, -0.2)).toBe(0);
  });

  it('rejects a space that does not satisfy the shared schema, naming the field', () => {
    const broken = { ...SLOPED_SPACE, floor: { ...SLOPED_SPACE.floor, nx: 1 } } as TankSpace;
    expect(() => Basin.fromSpace(broken)).toThrow(/space is not a valid TankSpace: floor\.nx/);
  });
});

describe('World config frame', () => {
  const base = { seed: 1, species: [neonTetra], fish: spawnMany('neon-tetra', 2) };

  it('takes exactly one of space and tank', () => {
    const both = { ...base, space: SLOPED_SPACE, tank: SHOW_TANK } as unknown as AnyWorldConfig;
    const neither = base as unknown as AnyWorldConfig;
    expect(() => new World(both)).toThrow(/either space or tank, not both/);
    expect(() => new World(neither)).toThrow(/needs space \(tank space\) or tank/);
  });

  it('measures the tank wall from the sloped sand, tilted with it', () => {
    const sdf = new TankSdf(Basin.fromSpace(SLOPED_SPACE));
    const n = new Float64Array(3);
    const [, sz] = sampleFloorSlope(SLOPED_SPACE, 0, 0);
    const g = sampleFloor(SLOPED_SPACE, 0, 0);
    const lift = 0.02;
    expect(sdf.sample(0, g + lift, 0, n)).toBeCloseTo(lift / Math.hypot(1, sz), 12);
    expect(at(n, 1)).toBeCloseTo(1 / Math.hypot(1, sz), 12);
    expect(at(n, 2)).toBeCloseTo(-sz / Math.hypot(1, sz), 12);
    expect(sdf.sample(0, g - 0.005, 0, n)).toBeLessThan(0);
  });
});

describe('fish on sloped sand', { timeout: LONG }, () => {
  it('cories rest on the sand where it lies, low at the front and high at the back', () => {
    const w = sloped(spawnMany('bronze-corydoras', 6), 5);
    const length = bronzeCorydoras.locomotion.bodyLengthM;
    let worst = Infinity;
    const halves = { front: { y: 0, ground: 0, n: 0 }, back: { y: 0, ground: 0, n: 0 } };
    let above = 0;
    let underHighestSand = 0;
    let samples = 0;
    for (let t = 0; t < 9000; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        worst = Math.min(worst, w.bodyClearance(i));
        if (t < 600 || at(w.state, i) !== FishState.Forage) continue;
        const x = at(w.position, i * 3);
        const y = at(w.position, i * 3 + 1);
        const z = at(w.position, i * 3 + 2);
        const ground = w.basin.ground(x, z);
        above += y - ground;
        samples++;
        if (y < w.basin.floorMax) underHighestSand++;
        const half = z > 0.1 ? halves.front : z < 0 ? halves.back : null;
        if (half !== null) {
          half.y += y;
          half.ground += ground;
          half.n++;
        }
      }
    }
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
    expect(samples).toBeGreaterThan(1000);
    // Foraging cories hold their belly over the sand, a fraction of a body length up.
    expect(above / samples).toBeGreaterThan(0);
    expect(above / samples).toBeLessThan(0.6 * length);
    // A flat floor at the highest sand would hold every one of them above it.
    expect(underHighestSand / samples).toBeGreaterThan(0.5);
    const { front, back } = halves;
    expect(Math.min(front.n, back.n)).toBeGreaterThan(500);
    const climb = back.y / back.n - front.y / front.n;
    const sandClimb = back.ground / back.n - front.ground / front.n;
    expect(sandClimb).toBeGreaterThan(0.015);
    expect(Math.abs(climb - sandClimb)).toBeLessThan(0.01);
  });

  it('keeps every fish out of a hull rock that they would otherwise swim through', () => {
    const planes = fitHullPlanes(ROCK.kind === 'hull' ? ROCK.vertices.flat() : []);
    const rockDistance = (x: number, y: number, z: number): number => {
      let d = -Infinity;
      for (let k = 0; k < planes.length; k += 4) {
        const plane =
          at(planes, k) * x + at(planes, k + 1) * y + at(planes, k + 2) * z - at(planes, k + 3);
        d = Math.max(d, plane);
      }
      return d;
    };
    const run = (decor: readonly Collider[]): { worst: number; inside: number; near: number } => {
      const fish = [
        ...spawnMany('neon-tetra', 12),
        ...spawnMany('angelfish', 2),
        ...spawnMany('bronze-corydoras', 4),
      ];
      const w = sloped(fish, 9, decor);
      let worst = Infinity;
      let inside = 0;
      let near = 0;
      for (let t = 0; t < 6000; t++) {
        w.step();
        for (let i = 0; i < w.count; i++) {
          const o = i * 3;
          const d = rockDistance(at(w.position, o), at(w.position, o + 1), at(w.position, o + 2));
          worst = Math.min(worst, d - at(w.thickness, i), w.bodyClearance(i));
          if (d < 0) inside++;
          else if (d < 0.06) near++;
        }
      }
      return { worst, inside, near };
    };
    const open = run([]);
    expect(open.inside).toBeGreaterThan(100);
    const rocky = run([ROCK]);
    expect(rocky.worst).toBeGreaterThanOrEqual(-1e-9);
    expect(rocky.inside).toBe(0);
    expect(rocky.near).toBeGreaterThan(100);
  });

  it('reproduces a tank-space run bit for bit, taps, food and a moved rock included', () => {
    const drive = (): { w: World; ate: AteEvent[] } => {
      const w = sloped([...spawnMany('neon-tetra', 10), ...spawnMany('bronze-corydoras', 4)], 13, [
        ROCK,
      ]);
      const rain = new FoodRain(w.basin);
      const ate: AteEvent[] = [];
      for (let t = 0; t < 2000; t++) {
        if (t === 100) rain.sprinkle('pellets', 6, 0, 0.1, 0.08);
        if (t === 300) w.startle({ position: [0, 0.25, 0.2], intensity: 1 });
        if (t === 900) {
          w.setDecor([{ ...ROCK, id: 'rock', vertices: rockVertices(-0.3, 0.05, 0.05) }]);
        }
        rain.feed(w);
        w.step();
        const events = w.takeAteEvents();
        rain.eat(events);
        ate.push(...events);
      }
      return { w, ate };
    };
    const a = drive();
    const b = drive();
    expect(stateOf(a.w)).toEqual(stateOf(b.w));
    expect(Array.from(a.w.state)).toEqual(Array.from(b.w.state));
    expect(a.ate).toEqual(b.ate);
    expect(a.ate.length).toBeGreaterThan(0);
  });
});

describe('positions on the bridge share the world frame', { timeout: LONG }, () => {
  it('clamps food below the sand up onto it, where the sand is at that spot', () => {
    const w = sloped(spawnMany('bronze-corydoras', 1));
    const front = w.basin.maxZ - 0.01;
    const back = w.basin.minZ + 0.01;
    w.setFood(new Float32Array([1, 0, 0, front, 0, 2, 0, 0.02, back, 0, 3, 0, 9, 0, 0]));
    expect(w.food.count).toBe(3);
    expect(at(w.food.position, 1)).toBe(w.basin.ground(0, at(w.food.position, 2)));
    expect(at(w.food.position, 4)).toBe(w.basin.ground(0, at(w.food.position, 5)));
    expect(at(w.food.position, 7)).toBe(w.basin.maxY);
  });

  it('lets cories find and eat pellets on the sloped sand', () => {
    const w = sloped(spawnMany('bronze-corydoras', 4), 3);
    const rain = new FoodRain(w.basin);
    rain.sprinkle('pellets', 12, 0, 0.1, 0.1);
    let lowest = Infinity;
    for (let t = 0; t < 4000 && rain.count > 0; t++) {
      rain.feed(w);
      w.step();
      for (let k = 0; k < w.food.count; k++) {
        const x = at(w.food.position, k * 3);
        const z = at(w.food.position, k * 3 + 2);
        lowest = Math.min(lowest, at(w.food.position, k * 3 + 1) - w.basin.ground(x, z));
      }
      rain.eat(w.takeAteEvents());
    }
    expect(lowest).toBeGreaterThanOrEqual(0);
    expect(rain.eaten).toBeGreaterThan(0);
  });

  it('startles a fish from a tap at its own tank-space position', () => {
    const w = sloped(spawnMany('neon-tetra', 6), 2);
    for (let t = 0; t < 300; t++) w.step();
    const p: Point3 = [at(w.position, 0), at(w.position, 1), at(w.position, 2) + 0.04];
    w.startle({ position: p, intensity: 1 });
    let startled = false;
    for (let t = 0; t < 30; t++) {
      w.step();
      if (at(w.state, 0) === FishState.Startle) startled = true;
    }
    expect(startled).toBe(true);
    expect(at(w.behaviour.startledAt, 0)).toBeGreaterThanOrEqual(300);
  });
});
