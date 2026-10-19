import { foodTypeSchema } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import {
  FEEDING_WINDOW_MINUTES,
  HUNGER_PER_PORTION,
  MAX_PORTIONS_PER_FISH_PER_WINDOW,
} from '../lifecycle/params.ts';
import { FEEDING, gutForHunger } from './feeding.ts';
import {
  ARCHETYPES,
  benchmarkConfig,
  betta,
  bronzeCorydoras,
  FoodRain,
  neonTetra,
  otocinclus,
  REEF_ANCHORS,
  REEF_DECOR,
  REEF_TANK,
  SHOW_DECOR,
  SHOW_TANK,
  spawnMany,
  yellowTang,
} from './fixtures.ts';
import {
  FOOD_PARTICLES,
  FOOD_STRIDE,
  FOOD_TYPES,
  FoodStore,
  MAX_FOOD_PARTICLES,
  type AteEvent,
} from './food.ts';
import { FishState } from './snapshot.ts';
import { toSimSpecies, type SpeciesInput } from './species.ts';
import { STEERING, STEP_DT, World, type FishSpawn, type WorldConfig } from './world.ts';

const LONG = 60_000;

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

function records(...particles: (readonly number[])[]): Float32Array {
  return new Float32Array(particles.flat());
}

function type(name: (typeof FOOD_TYPES)[number]): number {
  return FOOD_TYPES.indexOf(name);
}

function tank(fish: FishSpawn[], seed = 1, species: readonly SpeciesInput[] = ARCHETYPES): World {
  return new World({ seed, tank: SHOW_TANK, species, decor: [], fish });
}

/** Puts fish `i` at a point, heading along +x, so food can be laid out around it. */
function pose(w: World, i: number, x: number, y: number, z: number, yaw = Math.PI / 2): void {
  w.position[i * 3] = x;
  w.position[i * 3 + 1] = y;
  w.position[i * 3 + 2] = z;
  w.yaw[i] = yaw;
  w.pitch[i] = 0;
}

function feedFor(
  w: World,
  rain: FoodRain,
  steps: number,
  each?: (t: number, events: readonly AteEvent[]) => void,
): AteEvent[] {
  const all: AteEvent[] = [];
  for (let t = 0; t < steps; t++) {
    rain.feed(w);
    w.step();
    const events = w.takeAteEvents();
    rain.eat(events);
    all.push(...events);
    each?.(t, events);
  }
  return all;
}

describe('food input', () => {
  const store = (): FoodStore => new FoodStore(SHOW_TANK);

  it('uses the shared food type order for typeIndex', () => {
    expect([...FOOD_TYPES]).toEqual(foodTypeSchema.options);
    for (const t of FOOD_TYPES) {
      expect(FOOD_PARTICLES[t].portion).toBeGreaterThan(0);
      expect(FOOD_PARTICLES[t].feeders).toBeGreaterThanOrEqual(1);
    }
  });

  it('accepts an empty buffer and finds particles by id', () => {
    const s = store();
    s.set(new Float32Array(0), 0);
    expect(s.count).toBe(0);
    s.set(records([7, 0, 0.2, 0, type('flakes')], [9, 0.1, 0.3, 0, type('nori')]), 1);
    expect(s.count).toBe(2);
    expect(s.indexOf(9)).toBe(1);
    expect(s.indexOf(8)).toBe(-1);
    expect(s.remaining(1)).toBe(FOOD_PARTICLES.nori.portion);
    expect(s.feeders(1)).toBe(FOOD_PARTICLES.nori.feeders);
  });

  it('rejects a bad buffer as a whole and keeps the previous food', () => {
    const s = store();
    const good = records([1, 0, 0.2, 0, type('pellets')]);
    s.set(good, 0);
    const bad: [string, Float32Array, RegExp][] = [
      ['short record', new Float32Array([1, 0, 0.2, 0]), /stride/],
      ['fractional id', records([1.5, 0, 0.2, 0, 0]), /id must be an integer/],
      ['negative id', records([-1, 0, 0.2, 0, 0]), /id must be an integer/],
      ['repeated id', records([2, 0, 0.2, 0, 0], [2, 0.1, 0.2, 0, 0]), /unique/],
      ['NaN position', records([2, 0, Number.NaN, 0, 0]), /finite/],
      ['infinite position', records([2, Infinity, 0.2, 0, 0]), /finite/],
      ['unknown type', records([2, 0, 0.2, 0, FOOD_TYPES.length]), /typeIndex/],
      ['fractional type', records([2, 0, 0.2, 0, 0.5]), /typeIndex/],
      [
        'too many particles',
        new Float32Array((MAX_FOOD_PARTICLES + 1) * FOOD_STRIDE).map((_, k) =>
          k % FOOD_STRIDE === 0 ? k / FOOD_STRIDE : 0.1,
        ),
        /cap/,
      ],
    ];
    for (const [, buffer, message] of bad) {
      // A valid record ahead of the bad one must not slip in either.
      const mixed = new Float32Array(FOOD_STRIDE + buffer.length);
      mixed.set([99, 0, 0.3, 0, 0]);
      mixed.set(buffer, FOOD_STRIDE);
      expect(() => s.set(buffer.length % FOOD_STRIDE === 0 ? mixed : buffer, 1)).toThrow(message);
      expect(s.count).toBe(1);
      expect(s.indexOf(1)).toBe(0);
      expect(s.indexOf(99)).toBe(-1);
    }
    expect(() => s.set([1, 0, 0.2, 0, 0] as unknown as Float32Array, 1)).toThrow(/Float32Array/);
  });

  it('clamps particles outside the water box onto it instead of dropping the buffer', () => {
    const s = store();
    const { width, height, depth } = SHOW_TANK;
    s.set(
      records(
        [1, 0, 0.2, 0, type('flakes')],
        [2, 0, height + 0.07, 0, type('flakes')],
        [3, 0, -0.05, 0, type('pellets')],
        [4, width, 0.2, -depth, type('pellets')],
        [5, -width, 0.2, depth, type('nori')],
      ),
      0,
    );
    expect(s.count).toBe(5);
    const position = (id: number): number[] =>
      Array.from(s.position.subarray(s.indexOf(id) * 3, s.indexOf(id) * 3 + 3));
    expect(position(1)).toEqual([0, Math.fround(0.2), 0]);
    expect(position(2)).toEqual([0, height, 0]);
    expect(position(3)).toEqual([0, 0, 0]);
    expect(position(4)).toEqual([width / 2, Math.fround(0.2), -depth / 2]);
    expect(position(5)).toEqual([-width / 2, Math.fround(0.2), depth / 2]);
    const hits = new Int32Array(MAX_FOOD_PARTICLES);
    expect(s.near(width / 2, 0.2, -depth / 2, 0.01, hits)).toBe(1);
    expect(at(hits, 0)).toBe(s.indexOf(4));
  });

  it('keeps clamped particles still: a particle held at the floor reads as resting', () => {
    const s = store();
    for (let t = 0; t < 30; t++) s.set(records([1, 0, -0.05 - 0.01 * t, 0, type('pellets')]), t);
    expect(at(s.speed, s.indexOf(1))).toBe(0);
  });

  it('answers range queries exactly like a brute-force scan', () => {
    const s = store();
    const n = 400;
    const buffer = new Float32Array(n * FOOD_STRIDE);
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let k = 0; k < n; k++) {
      buffer.set(
        [
          k,
          (rand() - 0.5) * SHOW_TANK.width,
          rand() * SHOW_TANK.height,
          (rand() - 0.5) * SHOW_TANK.depth,
          k % FOOD_TYPES.length,
        ],
        k * FOOD_STRIDE,
      );
    }
    s.set(buffer, 0);
    const out = new Int32Array(MAX_FOOD_PARTICLES);
    for (let q = 0; q < 50; q++) {
      const x = (rand() - 0.5) * SHOW_TANK.width;
      const y = rand() * SHOW_TANK.height;
      const z = (rand() - 0.5) * SHOW_TANK.depth;
      const r = 0.02 + rand() * 0.4;
      const found = Array.from(out.subarray(0, s.near(x, y, z, r, out))).sort((a, b) => a - b);
      const expected: number[] = [];
      for (let k = 0; k < n; k++) {
        const d = Math.hypot(
          at(s.position, k * 3) - x,
          at(s.position, k * 3 + 1) - y,
          at(s.position, k * 3 + 2) - z,
        );
        if (d <= r) expected.push(k);
      }
      expect(found).toEqual(expected);
    }
  });

  it('estimates how fast each particle moves from successive reports', () => {
    const s = store();
    for (let t = 0; t < 60; t++) {
      s.set(
        records(
          [1, 0, 0.4 - 0.02 * t * (1 / 30), 0, type('pellets')],
          [2, 0.2, 0.004, 0, type('pellets')],
        ),
        t,
      );
    }
    expect(at(s.speed, s.indexOf(1))).toBeCloseTo(0.02, 4);
    expect(at(s.speed, s.indexOf(2))).toBe(0);
  });

  it('tracks speed by id through reordered and repeated reports within a tick', () => {
    const s = store();
    for (let t = 0; t < 60; t++) {
      const y = 0.4 - 0.02 * t * (1 / 30);
      const a: [number, number, number, number, number] = [1, 0, y, 0, type('pellets')];
      const b: [number, number, number, number, number] = [2, 0.2, 0.004, 0, type('pellets')];
      s.set(t % 2 === 0 ? records(a, b) : records(b, a), t);
      s.set(records(b, [3, 0.1, 0.2, 0, type('flakes')], a), t);
    }
    expect(at(s.speed, s.indexOf(1))).toBeCloseTo(0.02, 4);
    expect(at(s.speed, s.indexOf(2))).toBe(0);
  });

  it('remembers what was eaten of a particle until the client drops it', () => {
    const s = store();
    s.set(records([5, 0, 0.3, 0, type('nori')]), 0);
    s.consume(0, 0.1);
    s.set(records([6, 0, 0.3, 0.1, type('flakes')], [5, 0, 0.3, 0, type('nori')]), 1);
    expect(s.remaining(s.indexOf(5))).toBeCloseTo(FOOD_PARTICLES.nori.portion - 0.1, 12);
    s.set(records([6, 0, 0.3, 0.1, type('flakes')]), 2);
    s.set(records([5, 0, 0.3, 0, type('nori')]), 3);
    expect(s.remaining(s.indexOf(5))).toBe(FOOD_PARTICLES.nori.portion);
  });
});

describe('diet preference', () => {
  it('ranks foods in diet order and ignores food off the diet', () => {
    const tang = toSimSpecies(yellowTang);
    const order = ['nori', 'algae-wafer', 'flakes'] as const;
    for (let r = 1; r < order.length; r++) {
      expect(at(tang.foodPreference, type(order[r - 1] ?? 'nori'))).toBeGreaterThan(
        at(tang.foodPreference, type(order[r] ?? 'nori')),
      );
    }
    expect(at(tang.foodPreference, type('nori'))).toBe(1);
    expect(at(tang.foodPreference, type('bloodworms'))).toBe(0);
  });

  it('rejects an empty, unknown or repeated diet', () => {
    const withDiet = (diet: unknown): SpeciesInput =>
      ({ ...neonTetra, lifecycle: { diet } }) as unknown as SpeciesInput;
    expect(() => toSimSpecies(withDiet([]))).toThrow(/diet/);
    expect(() => toSimSpecies(withDiet(['plankton']))).toThrow(/plankton/);
    expect(() => toSimSpecies(withDiet(['flakes', 'flakes']))).toThrow(/flakes/);
    expect(() =>
      toSimSpecies({ ...neonTetra, lifecycle: undefined } as unknown as SpeciesInput),
    ).toThrow(/lifecycle/);
  });
});

describe('feeding AI', { timeout: LONG }, () => {
  it('is inert without food: an empty food buffer leaves the trajectory bit-identical', () => {
    const a = new World(benchmarkConfig(4));
    const b = new World(benchmarkConfig(4));
    for (let t = 0; t < 600; t++) {
      a.step();
      b.setFood(new Float32Array(0));
      b.step();
    }
    expect(Array.from(b.position)).toEqual(Array.from(a.position));
    expect(b.takeAteEvents()).toEqual([]);
  });

  it('reproduces a feeding frenzy bit for bit from the same seed', () => {
    const runOnce = (): [Float64Array, AteEvent[]] => {
      const w = new World(benchmarkConfig(5));
      const rain = new FoodRain(REEF_TANK);
      rain.sprinkle('flakes', 80, -0.3, 0, 0.15, 5);
      rain.sprinkle('pellets', 30, 0.3, 0.1, 0.1);
      rain.place('nori', 0.85, 0.35, 0.25);
      const events = feedFor(w, rain, 1200);
      return [new Float64Array(w.position), events];
    };
    const [p1, e1] = runOnce();
    const [p2, e2] = runOnce();
    expect(e1.length).toBeGreaterThan(20);
    expect(e2).toEqual(e1);
    expect(Array.from(p2)).toEqual(Array.from(p1));
  });

  it('sees food only within its perception range and visual field', () => {
    const narrow: SpeciesInput = {
      ...neonTetra,
      behaviour: { ...neonTetra.behaviour, perceptionFovDeg: 120 },
    };
    const look = (dx: number, dz: number): number => {
      const w = tank([{ id: 'a', species: neonTetra.id }], 1, [narrow]);
      pose(w, 0, 0, 0.25, 0);
      w.setFood(records([1, dx, 0.25, dz, type('flakes')]));
      w.step();
      return at(w.behaviour.feeding.target, 0);
    };
    const range = toSimSpecies(narrow).perceptionRange;
    expect(look(0.5 * range, 0)).toBe(0);
    expect(look(0.5 * range * Math.cos(0.9), 0.5 * range * Math.sin(0.9))).toBe(0);
    expect(look(0.5 * range * Math.cos(1.2), 0.5 * range * Math.sin(1.2))).toBe(-1);
    expect(look(-0.5 * range, 0)).toBe(-1);
    expect(look(1.1 * range, 0)).toBe(-1);
  });

  it('prefers sinking food over food lying still at the same distance', () => {
    const w = tank([{ id: 'a', species: neonTetra.id }]);
    const { feeding } = w.behaviour;
    const report = (t: number): void => {
      w.setFood(
        records(
          [1, 0.1, 0.25, 0.06, type('flakes')],
          [2, 0.1, 0.25 - 0.01 * (t / 30), -0.06, type('flakes')],
        ),
      );
    };
    feeding.gut[0] = FEEDING.satiationPortions;
    for (let t = 0; t < 30; t++) {
      pose(w, 0, 0, 0.25, 0);
      report(t);
      w.step();
    }
    expect(at(feeding.target, 0)).toBe(-1);
    feeding.gut[0] = 0;
    pose(w, 0, 0, 0.25 - 0.005, 0);
    report(30);
    w.step();
    expect(w.food.indexOf(2)).toBe(at(feeding.target, 0));
  });

  it('lets the nearest fish take a particle and sends the others elsewhere', () => {
    const w = tank(spawnMany(neonTetra.id, 3));
    pose(w, 0, 0, 0.25, 0);
    pose(w, 1, 0.12, 0.25, 0.02, -Math.PI / 2);
    pose(w, 2, -0.2, 0.25, 0.1);
    w.setFood(records([1, 0.04, 0.25, 0, type('flakes')], [2, 0.1, 0.25, 0.1, type('flakes')]));
    w.step();
    const { target } = w.behaviour.feeding;
    expect(at(target, 0)).toBe(w.food.indexOf(1));
    expect(at(target, 1)).toBe(w.food.indexOf(2));
    expect(at(target, 2)).toBe(-1);
  });

  it('never has more fish on a particle than can feed from it', () => {
    const w = new World(benchmarkConfig(6));
    const rain = new FoodRain(REEF_TANK);
    rain.sprinkle('flakes', 40, 0, 0, 0.3, 3);
    rain.sprinkle('algae-wafer', 3, -0.2, 0.2, 0.1);
    rain.place('nori', -0.85, 0.3, 0.2);
    const { feeding } = w.behaviour;
    let feeders = 0;
    feedFor(w, rain, 1500, () => {
      const claims = new Map<number, number>();
      for (let i = 0; i < w.count; i++) {
        const k = at(feeding.target, i);
        if (k < 0) continue;
        feeders++;
        claims.set(k, (claims.get(k) ?? 0) + 1);
      }
      for (const [k, c] of claims) expect(c).toBeLessThanOrEqual(w.food.feeders(k));
    });
    expect(feeders).toBeGreaterThan(0);
  });

  it('eats until sated, then ignores food, within the lifecycle cap per window', () => {
    // The stomach empties with time constant τ; over one lifecycle window the most a fish can eat
    // is a full meal plus what has been evacuated since.
    const window = FEEDING_WINDOW_MINUTES * 60;
    const most =
      FEEDING.satiationPortions * (1 + (1 - Math.exp(-window / FEEDING.gastricEvacuationTauS)));
    expect(most).toBeLessThanOrEqual(MAX_PORTIONS_PER_FISH_PER_WINDOW);
    for (let seed = 1; seed <= 4; seed++) {
      const w = tank([{ id: 'a', species: neonTetra.id }], seed);
      const rain = new FoodRain(SHOW_TANK);
      for (let k = 0; k < 80; k++) {
        rain.place('flakes', -0.3 + (k % 10) * 0.06, 0.2 + 0.02 * Math.floor(k / 10), 0, 0, 0);
      }
      const events = feedFor(w, rain, 9000);
      const eaten = events.reduce((s, e) => s + e.portion, 0);
      expect(eaten, `seed ${seed}`).toBeGreaterThan(0.9 * FEEDING.satiationPortions);
      expect(eaten, `seed ${seed}`).toBeLessThanOrEqual(FEEDING.satiationPortions + 1e-9);
      expect(rain.count, `seed ${seed}`).toBeGreaterThan(0);
      expect(at(w.behaviour.feeding.target, 0), `seed ${seed}`).toBe(-1);
      expect(w.state[0], `seed ${seed}`).not.toBe(FishState.Feed);
      for (const e of events) {
        expect(e.fishId).toBe('a');
        expect(e.portion).toBeGreaterThan(0);
      }
    }
  });

  it('has a lone tetra bite the flake it goes for instead of circling it, on every seed', () => {
    // A flake beside the fish lies inside the circle it sweeps on its cruising arc; swimming on
    // only orbits it (#668), so it has to brake and turn onto it.
    let pursuits = 0;
    let bitten = 0;
    let slowest = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const w = tank([{ id: 'a', species: neonTetra.id }], seed);
      const rain = new FoodRain(SHOW_TANK);
      for (let k = 0; k < 80; k++) {
        rain.place('flakes', -0.3 + (k % 10) * 0.06, 0.2 + 0.02 * Math.floor(k / 10), 0, 0, 0);
      }
      let chasing = -1;
      let since = 0;
      let eaten = 0;
      let satedAt = Infinity;
      for (let t = 0; t < 3000; t++) {
        rain.feed(w);
        w.step();
        const events = w.takeAteEvents();
        rain.eat(events);
        const k = at(w.behaviour.feeding.target, 0);
        const id = k >= 0 ? at(w.food.id, k) : -1;
        const bite = events.find((e) => e.foodId === chasing);
        for (const e of events) eaten += e.portion;
        if (eaten >= 0.9 * FEEDING.satiationPortions) satedAt = Math.min(satedAt, t);
        since++;
        if (bite !== undefined) {
          bitten++;
          slowest = Math.max(slowest, since);
          chasing = -1;
        } else if (id !== chasing) {
          chasing = -1;
        }
        if (chasing < 0 && id >= 0 && events.length === 0) {
          chasing = id;
          since = 0;
          pursuits++;
        }
      }
      expect(satedAt, `seed ${seed}`).toBeLessThan(3000);
    }
    expect(bitten / pursuits).toBeGreaterThan(0.95);
    expect(slowest * STEP_DT).toBeLessThan(4);
  });

  it('takes its favourite food and leaves food off its diet alone', () => {
    const tang = new World({
      seed: 2,
      tank: REEF_TANK,
      species: ARCHETYPES,
      decor: [],
      fish: [{ id: 't', species: yellowTang.id }],
    });
    pose(tang, 0, 0, 0.3, 0);
    tang.setFood(records([1, 0.2, 0.3, 0.08, type('flakes')], [2, 0.2, 0.3, -0.08, type('nori')]));
    tang.step();
    expect(at(tang.behaviour.feeding.target, 0)).toBe(tang.food.indexOf(2));

    const w = tank([...spawnMany(neonTetra.id, 6), ...spawnMany(otocinclus.id, 3)]);
    const rain = new FoodRain(SHOW_TANK);
    rain.sprinkle('algae-wafer', 4, 0, 0, 0.2);
    rain.sprinkle('nori', 3, 0.2, 0, 0.1);
    rain.sprinkle('flakes', 30, 0, 0, 0.3, 2);
    const events = feedFor(w, rain, 3000);
    const typeOf = new Map<number, string>();
    for (const e of events) typeOf.set(e.foodId, typeOf.get(e.foodId) ?? '');
    for (const e of events) {
      const fish = w.fishIds.indexOf(e.fishId);
      const sp = w.speciesOf(fish);
      expect(sp.id === neonTetra.id || sp.id === otocinclus.id).toBe(true);
    }
    const tetraFood = new Set(
      events.filter((e) => e.fishId.startsWith(neonTetra.id)).map((e) => e.foodId),
    );
    const otoFood = new Set(
      events.filter((e) => e.fishId.startsWith(otocinclus.id)).map((e) => e.foodId),
    );
    // Ids 1–4 are wafers, 5–7 nori, the rest flakes.
    for (const id of tetraFood) expect(id).toBeGreaterThan(7);
    for (const id of otoFood) expect(id).toBeLessThanOrEqual(7);
    expect(tetraFood.size).toBeGreaterThan(0);
  });

  it('keeps corydoras on the bottom until sinking food comes down to them', () => {
    const w = tank(spawnMany(bronzeCorydoras.id, 4), 3);
    for (let t = 0; t < 300; t++) w.step();
    const rain = new FoodRain(SHOW_TANK);
    rain.sprinkle('pellets', 12, 0, 0, 0.3);
    const { feeding } = w.behaviour;
    let firstHeight = Infinity;
    let highest = 0;
    let gulpBites = 0;
    const events = feedFor(w, rain, 2400, (_, bites) => {
      for (const e of bites) {
        if (w.state[w.fishIds.indexOf(e.fishId)] === FishState.Gulp) gulpBites++;
      }
      for (let i = 0; i < w.count; i++) {
        // A dash to the surface for air is not swimming up to the food.
        if (w.state[i] !== FishState.Gulp) highest = Math.max(highest, at(w.position, i * 3 + 1));
        const k = at(feeding.target, i);
        if (k >= 0 && firstHeight === Infinity) firstHeight = at(w.food.position, k * 3 + 1);
      }
    });
    const cory = toSimSpecies(bronzeCorydoras);
    const reach = (cory.depthHigh + FEEDING.bottomZoneReach) * SHOW_TANK.height;
    expect(firstHeight).toBeLessThanOrEqual(reach);
    expect(events.length).toBeGreaterThan(4);
    // Leaving gulps out of the height check must not hide food taken during a dash.
    expect(gulpBites).toBe(0);
    expect(highest).toBeLessThan(SHOW_TANK.height - 0.05);
  });

  it('has tangs rasp at a nori clip in small bites', () => {
    const w = new World({
      seed: 4,
      tank: REEF_TANK,
      species: ARCHETYPES,
      decor: REEF_DECOR,
      anchors: REEF_ANCHORS,
      fish: spawnMany(yellowTang.id, 2),
    });
    const rain = new FoodRain(REEF_TANK);
    const nori = rain.place('nori', 0.85, 0.35, 0);
    let grazing = 0;
    const events = feedFor(w, rain, 2700, () => {
      for (let i = 0; i < w.count; i++) if (w.state[i] === FishState.Feed) grazing++;
    });
    const bites = events.filter((e) => e.foodId === nori);
    expect(bites.length).toBeGreaterThan(5);
    expect(new Set(bites.map((b) => b.fishId)).size).toBe(w.count);
    for (const b of bites) expect(b.portion).toBeLessThanOrEqual(FEEDING.grazeBitePortion + 1e-12);
    expect(grazing).toBeGreaterThan(300);
  });

  it('gives up on nori behind rock once it stops closing in, then leaves it be', () => {
    // A 6 mm slot between a slab and the back pane: the tang sees the clip but cannot get in.
    // Swimming up to the slab does not count against the pursuit clock; pressing on it does.
    const back = -REEF_TANK.depth / 2;
    for (let seed = 1; seed <= 3; seed++) {
      const w = new World({
        seed,
        tank: REEF_TANK,
        species: ARCHETYPES,
        decor: [
          {
            id: 'slab',
            hard: true,
            kind: 'box',
            center: [0, 0.25, back + 0.046],
            halfExtents: [0.3, 0.25, 0.04],
            rotationY: 0,
            rounding: 0,
          },
        ],
        fish: spawnMany(yellowTang.id, 1),
      });
      pose(w, 0, 0, 0.3, back + 0.3, Math.PI);
      const rain = new FoodRain(REEF_TANK);
      const nori = rain.place('nori', 0, 0.3, back + 0.003);
      let chased = -1;
      let dropped = -1;
      let retargeted = false;
      const events = feedFor(
        w,
        rain,
        (FEEDING.pursuitTimeoutS + 4 + FEEDING.ignoreS) / STEP_DT,
        (t) => {
          const target = at(w.behaviour.feeding.target, 0);
          if (chased < 0 && target >= 0) chased = t * STEP_DT;
          else if (chased >= 0 && dropped < 0 && target < 0) dropped = t * STEP_DT;
          else if (dropped >= 0 && t * STEP_DT < dropped + 0.9 * FEEDING.ignoreS && target >= 0)
            retargeted = true;
        },
      );
      const label = `seed ${seed}`;
      expect(
        events.filter((e) => e.foodId === nori),
        label,
      ).toEqual([]);
      expect(chased, label).toBe(0);
      expect(dropped - chased, label).toBeGreaterThan(FEEDING.pursuitTimeoutS + 1);
      expect(dropped - chased, label).toBeLessThan(FEEDING.pursuitTimeoutS + 4);
      expect(retargeted, label).toBe(false);
    }
  });

  it('lets two tangs graze one clip side by side, taking bites by turns', () => {
    // Bites within 2 s of the other tang's. Kept a full separation zone apart, one tang holds
    // the clip and the other hangs back: on seeds 1 and 6 they never once bite together.
    const window = 2 / STEP_DT;
    for (let seed = 1; seed <= 8; seed++) {
      const w = new World({
        seed,
        tank: REEF_TANK,
        species: ARCHETYPES,
        decor: REEF_DECOR,
        anchors: REEF_ANCHORS,
        fish: spawnMany(yellowTang.id, 2),
      });
      const rain = new FoodRain(REEF_TANK);
      const nori = rain.place('nori', 0.85, 0.35, 0);
      const last = [-Infinity, -Infinity];
      let together = 0;
      for (let t = 0; t < 2700; t++) {
        rain.feed(w);
        w.step();
        const events = w.takeAteEvents();
        rain.eat(events);
        for (const e of events) {
          if (e.foodId !== nori) continue;
          const i = w.fishIds.indexOf(e.fishId);
          if (i < 0) throw new Error(`bite by unknown fish ${e.fishId}`);
          last[i] = t;
          if (t - (last[1 - i] ?? -Infinity) < window) together++;
        }
      }
      expect(together, `seed ${seed}`).toBeGreaterThanOrEqual(20);
    }
  });

  it('has a betta take flakes floating at the surface', () => {
    const w = tank([{ id: 'b', species: betta.id }], 2);
    const rain = new FoodRain(SHOW_TANK);
    rain.sprinkle('flakes', 10, 0, 0, 0.3, 120);
    const events = feedFor(w, rain, 1800);
    expect(events.length).toBeGreaterThanOrEqual(5);
  });

  it('keeps a clownfish by its anemone when food falls across the tank', () => {
    const w = new World({
      seed: 3,
      tank: REEF_TANK,
      species: ARCHETYPES,
      decor: REEF_DECOR,
      anchors: REEF_ANCHORS,
      fish: spawnMany('ocellaris-clownfish', 2),
    });
    const anemone = REEF_ANCHORS[0];
    if (anemone === undefined) throw new Error('no anemone');
    const rain = new FoodRain(REEF_TANK);
    rain.sprinkle('flakes', 20, 0.8, 0, 0.05, 30);
    rain.sprinkle('flakes', 20, -0.2, 0.08, 0.1);
    let farthest = 0;
    const events = feedFor(w, rain, 1800, () => {
      for (let i = 0; i < w.count; i++) {
        farthest = Math.max(
          farthest,
          Math.hypot(
            at(w.position, i * 3) - anemone.position[0],
            at(w.position, i * 3 + 1) - anemone.position[1],
            at(w.position, i * 3 + 2) - anemone.position[2],
          ),
        );
      }
    });
    const length = toSimSpecies(
      ARCHETYPES.find((s) => s.id === 'ocellaris-clownfish') ?? betta,
    ).bodyLength;
    expect(events.length).toBeGreaterThan(0);
    expect(farthest).toBeLessThan(anemone.radius + (FEEDING.leashBodyLengths + 1.5) * length);
  });

  it('draws a hungry fish that sees no food towards a neighbour that is feeding', () => {
    const w = tank(spawnMany(neonTetra.id, 2));
    const range = toSimSpecies(neonTetra).perceptionRange;
    pose(w, 0, 0, 0.25, 0);
    pose(w, 1, -0.6 * range, 0.25, 0);
    w.setFood(records([1, 0.5 * range, 0.25, 0, type('flakes')]));
    w.step();
    expect(at(w.behaviour.feeding.target, 0)).toBe(0);
    expect(at(w.behaviour.feeding.target, 1)).toBe(-1);
    expect(at(w.behaviour.feeding.follow, 1)).toBe(0);
  });

  it('does not set off startles or habituation in a frenzy', () => {
    const w = new World(benchmarkConfig(7));
    const rain = new FoodRain(REEF_TANK);
    rain.sprinkle('flakes', 150, 0, 0, 0.4, 4);
    rain.sprinkle('pellets', 40, -0.3, 0.1, 0.2);
    feedFor(w, rain, 1800, () => {
      for (let i = 0; i < w.count; i++) expect(w.state[i]).not.toBe(FishState.Startle);
    });
    for (let i = 0; i < w.count; i++) expect(at(w.behaviour.startledAt, i)).toBe(-1);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'keeps every fish out of glass and rock through repeated feedings (seed %i)',
    (seed) => {
      const w = new World(benchmarkConfig(seed));
      const rain = new FoodRain(REEF_TANK);
      let worst = Infinity;
      for (let round = 0; round < 5; round++) {
        rain.sprinkle('flakes', 60, -0.6 + 0.3 * round, 0.2 - 0.1 * round, 0.2, 5);
        rain.sprinkle('pellets', 20, 0.6 - 0.3 * round, -0.2, 0.15);
        rain.place('nori', round % 2 === 0 ? 0.89 : -0.89, 0.3, 0.1 * round - 0.2);
        feedFor(w, rain, 2000, () => {
          for (let i = 0; i < w.count; i++) worst = Math.min(worst, w.bodyClearance(i));
        });
      }
      expect(worst).toBeGreaterThanOrEqual(-1e-9);
      expect(w.contacts / (w.count * 10_000)).toBeLessThan(2e-3);
    },
  );

  it('turns on the cruising arc while chasing food', () => {
    const w = new World(benchmarkConfig(8));
    const rain = new FoodRain(REEF_TANK);
    rain.sprinkle('flakes', 120, 0, 0, 0.5, 3);
    rain.sprinkle('pellets', 30, 0.3, 0, 0.3);
    let checked = 0;
    const wasFeeding = new Uint8Array(w.count);
    const speedBefore = new Float64Array(w.count);
    const yawRateBefore = new Float64Array(w.count);
    feedFor(w, rain, 2400, () => {
      for (let i = 0; i < w.count; i++) {
        const length = at(w.bodyLength, i);
        if (
          w.state[i] === FishState.Feed &&
          wasFeeding[i] === 1 &&
          w.behaviour.plans[i]?.pivot === false &&
          w.bodyClearance(i) >= 0.3 * length
        ) {
          // The limit is set from the speed going into the step, and yaw rate eases towards it,
          // so a fish slowing down may carry its previous rate briefly but never exceed it.
          const arc = at(speedBefore, i) / (STEERING.minTurnRadiusBodyLengths * length);
          const limit = Math.min(
            w.speciesOf(i).maxTurnRate,
            Math.max(arc, STEERING.pivotTurnRateRadPerS),
          );
          const bound = Math.max(limit, Math.abs(at(yawRateBefore, i)));
          expect(Math.abs(at(w.yawRate, i))).toBeLessThanOrEqual(bound * 1.05 + 1e-9);
          checked++;
        }
        wasFeeding[i] = w.state[i] === FishState.Feed ? 1 : 0;
        speedBefore[i] = at(w.speed, i);
        yawRateBefore[i] = at(w.yawRate, i);
      }
    });
    expect(checked).toBeGreaterThan(1000);
  });

  it('lets a tetra school regroup once the food is gone', () => {
    const config: WorldConfig = {
      seed: 9,
      tank: SHOW_TANK,
      species: ARCHETYPES,
      decor: SHOW_DECOR,
      fish: spawnMany(neonTetra.id, 20),
    };
    const w = new World(config);
    for (let t = 0; t < 600; t++) w.step();
    const rain = new FoodRain(SHOW_TANK);
    rain.sprinkle('flakes', 60, 0, 0, 0.4, 3);
    feedFor(w, rain, 2400);
    const nearest = (): number => {
      let sum = 0;
      for (let i = 0; i < w.count; i++) {
        let best = Infinity;
        for (let j = 0; j < w.count; j++) {
          if (j === i) continue;
          best = Math.min(best, Math.sqrt(at(w.distSq, i * w.count + j)));
        }
        sum += best / at(w.bodyLength, i);
      }
      return sum / w.count;
    };
    let nnd = 0;
    let samples = 0;
    for (let t = 0; t < 1800; t++) {
      rain.feed(w);
      w.step();
      rain.eat(w.takeAteEvents());
      if (t >= 900 && t % 15 === 0) {
        nnd += nearest();
        samples++;
      }
    }
    expect(nnd / samples).toBeGreaterThan(0.5);
    expect(nnd / samples).toBeLessThan(2);
  });
});

describe('gut seeded from the lifecycle hunger', { timeout: LONG }, () => {
  /** 80 flakes laid out in front of a tetra, enough for more than a full meal. */
  function meal(): FoodRain {
    const rain = new FoodRain(SHOW_TANK);
    for (let k = 0; k < 80; k++) {
      rain.place('flakes', -0.3 + (k % 10) * 0.06, 0.2 + 0.02 * Math.floor(k / 10), 0, 0, 0);
    }
    return rain;
  }

  function eatenBy(hunger: number | undefined, steps: number, seed = 1): number {
    const spawn: FishSpawn = { id: 'a', species: neonTetra.id };
    const w = tank([hunger === undefined ? spawn : { ...spawn, hunger }], seed);
    return feedFor(w, meal(), steps).reduce((sum, e) => sum + e.portion, 0);
  }

  it('fills the gut by the portions the lifecycle says the fish is not short of', () => {
    expect(gutForHunger(0)).toBe(FEEDING.satiationPortions);
    expect(gutForHunger(HUNGER_PER_PORTION / 2)).toBeCloseTo(FEEDING.satiationPortions - 0.5, 12);
    expect(gutForHunger(HUNGER_PER_PORTION * FEEDING.satiationPortions)).toBe(0);
    expect(gutForHunger(1)).toBe(0);
  });

  it('starts each fish with the gut its hunger gives, and an empty one without', () => {
    const w = tank([
      { id: 'fed', species: neonTetra.id, hunger: 0 },
      { id: 'half', species: neonTetra.id, hunger: HUNGER_PER_PORTION / 2 },
      { id: 'starving', species: neonTetra.id, hunger: 1 },
      { id: 'unknown', species: neonTetra.id },
    ]);
    const f = w.behaviour.feeding;
    expect(Array.from(f.gut)).toEqual([1, 0.5, 0, 0].map((g) => g * FEEDING.satiationPortions));
    expect([0, 1, 2, 3].map((i) => f.motivation(i))).toEqual([0, 0.5, 1, 1]);
  });

  it('has a fish that was fed leave food in plain view alone', () => {
    const look = (hunger: number): number => {
      const w = tank([{ id: 'a', species: neonTetra.id, hunger }]);
      pose(w, 0, 0, 0.25, 0);
      w.setFood(records([1, 0.05, 0.25, 0, type('flakes')]));
      w.step();
      return at(w.behaviour.feeding.target, 0);
    };
    expect(look(0)).toBe(-1);
    expect(look(1)).toBe(0);
  });

  it('eats only what a part-fed fish has room for', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const half = eatenBy(HUNGER_PER_PORTION / 2, 3000, seed);
      expect(half, `seed ${seed}`).toBeGreaterThan(0.4 * FEEDING.satiationPortions);
      expect(half, `seed ${seed}`).toBeLessThanOrEqual(0.5 * FEEDING.satiationPortions + 0.01);
      expect(eatenBy(0, 3000, seed), `seed ${seed}`).toBeLessThan(0.05 * FEEDING.satiationPortions);
    }
  });

  it('runs a starving fish bit for bit as one loaded without a hunger', () => {
    const run = (hunger: number | undefined): Float64Array => {
      const spawns = spawnMany(neonTetra.id, 6).map((f) =>
        hunger === undefined ? f : { ...f, hunger },
      );
      const w = tank(spawns, 3);
      feedFor(w, meal(), 300);
      return w.position.slice();
    };
    expect(Array.from(run(1))).toEqual(Array.from(run(undefined)));
  });

  it('seeds the gut of a fish added to a running world', () => {
    const w = tank([{ id: 'a', species: neonTetra.id }]);
    const i = w.addFish({ id: 'b', species: neonTetra.id, hunger: HUNGER_PER_PORTION / 4 });
    expect(at(w.behaviour.feeding.gut, i)).toBeCloseTo(0.75 * FEEDING.satiationPortions, 12);
    expect(at(w.behaviour.feeding.gut, 0)).toBe(0);
  });

  it('rejects a hunger outside 0 to 1 at load and on add, changing nothing', () => {
    for (const [hunger, shown] of [
      [-0.1, '-0.1'],
      [1.5, '1.5'],
      [Number.NaN, 'NaN'],
    ] as const) {
      expect(() => tank([{ id: 'a', species: neonTetra.id, hunger }])).toThrow(
        `hunger must be a number within 0 to 1, got ${shown}`,
      );
      const w = tank([{ id: 'a', species: neonTetra.id }]);
      expect(() => w.addFish({ id: 'b', species: neonTetra.id, hunger })).toThrow(RangeError);
      expect(w.fishIds).toEqual(['a']);
    }
  });

  it('rejects a hunger that is not a number, as a malformed message would carry it', () => {
    for (const hunger of ['"0.5"', 'null', 'true', '[0.5]']) {
      const spawn = JSON.parse(
        `{"id":"b","species":"${neonTetra.id}","hunger":${hunger}}`,
      ) as FishSpawn;
      expect(() => tank([spawn])).toThrow(`hunger must be a number within 0 to 1, got ${hunger}`);
      const w = tank([{ id: 'a', species: neonTetra.id }]);
      expect(() => w.addFish(spawn)).toThrow(RangeError);
      expect(w.fishIds).toEqual(['a']);
    }
  });
});
