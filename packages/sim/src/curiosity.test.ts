import { describe, expect, it } from 'vitest';
import { CURIOSITY } from './curiosity.ts';
import type { Point3 } from './decor.ts';
import {
  angelfish,
  ARCHETYPES,
  betta,
  clownfish,
  REEF_ANCHORS,
  REEF_DECOR,
  REEF_TANK,
  SHOW_DECOR,
  SHOW_TANK,
  SLOPED_SPACE,
  spawnMany,
} from './fixtures.ts';
import { FOOD_STRIDE, FOOD_TYPES } from './food.ts';
import { STEP_HZ, World, type FishSpawn } from './world.ts';

const LONG = 120_000;
const FRONT = SHOW_TANK.depth / 2 - 0.003;

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

function show(fish: FishSpawn[], seed: number): World {
  return new World({ seed, tank: SHOW_TANK, species: ARCHETYPES, decor: [], fish });
}

function distanceTo(w: World, i: number, p: Point3): number {
  return Math.hypot(
    at(w.position, i * 3) - p[0],
    at(w.position, i * 3 + 1) - p[1],
    at(w.position, i * 3 + 2) - p[2],
  );
}

function following(w: World): number {
  return w.behaviour.curiosity.follow.reduce((n, f) => n + f, 0);
}

function seconds(s: number): number {
  return Math.round(s * STEP_HZ);
}

/** Flakes entering at one point, as a pinch dropped on the surface. */
function pinch(id: number, x: number, z: number): Float32Array {
  const records = new Float32Array(3 * FOOD_STRIDE);
  for (let k = 0; k < 3; k++) {
    records.set(
      [id + k, x + 0.01 * k, SHOW_TANK.height - 0.01, z, FOOD_TYPES.indexOf('flakes')],
      k * FOOD_STRIDE,
    );
  }
  return records;
}

describe('lure following', { timeout: LONG }, () => {
  it('closes on a lure on the front glass after a latency and holds off the pane', () => {
    const w = show(spawnMany('angelfish', 4), 3);
    const lure: Point3 = [0, 0.25, FRONT];
    w.setLure(lure);
    const latency =
      CURIOSITY.lureLatencyMinS +
      (CURIOSITY.lureLatencyMaxS - CURIOSITY.lureLatencyMinS) * (1 - angelfish.behaviour.curiosity);
    let firstFollow = -1;
    let worst = Infinity;
    let closest = Infinity;
    for (let t = 0; t < seconds(20); t++) {
      w.step();
      if (firstFollow < 0 && following(w) > 0) firstFollow = t;
      for (let i = 0; i < w.count; i++) {
        worst = Math.min(worst, w.bodyClearance(i));
        if (t > seconds(15) && w.behaviour.curiosity.follow[i] === 1) {
          closest = Math.min(closest, distanceTo(w, i, lure));
        }
      }
    }
    expect(firstFollow).toBeGreaterThanOrEqual(seconds(latency) - 1);
    expect(following(w)).toBeGreaterThan(0);
    const length = angelfish.locomotion.bodyLengthM;
    expect(closest).toBeLessThan(1.5 * length);
    // The stand-off keeps the body clear of the glass the dot is on.
    expect(closest).toBeGreaterThan(0.25 * length);
    expect(worst).toBeGreaterThanOrEqual(0);
  });

  it('tracks a lure swept along the glass, lagging it', () => {
    const w = show(spawnMany('angelfish', 4), 5);
    const sweepS = 16;
    const lureAt = (t: number): Point3 => {
      const phase = (t / seconds(sweepS)) * 2 * Math.PI;
      return [0.35 * Math.sin(phase), 0.25, FRONT];
    };
    for (let t = 0; t < seconds(10); t++) {
      w.setLure(lureAt(0));
      w.step();
    }
    expect(following(w)).toBeGreaterThan(0);
    const lag: number[] = [];
    for (let t = 0; t < seconds(sweepS / 2); t++) {
      const lure = lureAt(t);
      w.setLure(lure);
      w.step();
      // The nearest follower: the others spread out round it, as a school does.
      let nearest = Infinity;
      for (let i = 0; i < w.count; i++) {
        if (w.behaviour.curiosity.follow[i] === 1) {
          nearest = Math.min(nearest, Math.abs(at(w.position, i * 3) - lure[0]));
        }
      }
      if (nearest < Infinity) lag.push(nearest);
    }
    expect(lag.length).toBeGreaterThan(seconds(sweepS / 4));
    const mean = lag.reduce((a, b) => a + b, 0) / lag.length;
    expect(mean).toBeLessThan(0.15);
  });

  it('loses interest in a lure it has tracked, and takes it up again after recovering', () => {
    const w = show(spawnMany('betta', 1), 2);
    const lure: Point3 = [at(w.position, 0), 0.3, FRONT];
    w.setLure(lure);
    const attention = CURIOSITY.lureAttentionS * (0.5 + betta.behaviour.curiosity);
    let started = -1;
    let stopped = -1;
    let resumed = -1;
    for (let t = 0; t < seconds(400) && resumed < 0; t++) {
      w.step();
      const f = w.behaviour.curiosity.follow[0] === 1;
      if (started < 0 && f) started = t;
      else if (started >= 0 && stopped < 0 && !f) stopped = t;
      else if (stopped >= 0 && f) resumed = t;
    }
    expect(started).toBeGreaterThanOrEqual(0);
    expect(stopped - started).toBeLessThanOrEqual(seconds(attention) + 1);
    expect(stopped - started).toBeGreaterThan(seconds(0.5 * attention));
    // Interest returns only once habituation has decayed to `lureRecoverLevel`.
    const recover = CURIOSITY.lureRecoverTauS * Math.log(1 / CURIOSITY.lureRecoverLevel);
    expect(resumed - stopped).toBeGreaterThan(seconds(0.9 * recover));
  });

  it('releases every follower as soon as the lure is gone', () => {
    const w = show(spawnMany('angelfish', 4), 3);
    w.setLure([0, 0.25, FRONT]);
    for (let t = 0; t < seconds(10); t++) w.step();
    expect(following(w)).toBeGreaterThan(0);
    w.setLure(null);
    w.step();
    expect(following(w)).toBe(0);
    expect(w.behaviour.curiosity.lureActive).toBe(false);
  });

  it('keeps an anemone clownfish from following a lure beyond its excursion leash', () => {
    const w = new World({
      seed: 4,
      tank: REEF_TANK,
      species: ARCHETYPES,
      decor: REEF_DECOR,
      anchors: REEF_ANCHORS,
      fish: spawnMany('ocellaris-clownfish', 2),
    });
    const anemone = REEF_ANCHORS[0];
    if (anemone?.kind !== 'anemone') throw new Error('fixture lost its anemone');
    const leash =
      anemone.radius + CURIOSITY.lureLeashBodyLengths * clownfish.locomotion.bodyLengthM;
    const far: Point3 = [anemone.position[0] + leash + 0.05, 0.12, REEF_TANK.depth / 2 - 0.003];
    w.setLure(far);
    for (let t = 0; t < seconds(30); t++) {
      w.step();
      expect(following(w)).toBe(0);
    }
    const near: Point3 = [anemone.position[0], 0.12, REEF_TANK.depth / 2 - 0.003];
    w.setLure(near);
    let followed = false;
    for (let t = 0; t < seconds(30) && !followed; t++) {
      w.step();
      followed = following(w) > 0;
    }
    expect(followed).toBe(true);
  });

  it('rejects a lure that is not a finite point and moves one outside the water into it', () => {
    const w = show(spawnMany('angelfish', 4), 3);
    expect(() => w.setLure([0, Number.NaN, 0])).toThrow(/lure: position/);
    expect(() => w.setLure([0, 0.2] as unknown as Point3)).toThrow(/lure: position/);
    expect(w.behaviour.curiosity.lureActive).toBe(false);
    const { basin } = w;
    w.setLure([-5, 5, -5]);
    expect(Array.from(w.behaviour.curiosity.lure)).toEqual([basin.minX, basin.maxY, basin.minZ]);
    w.setLure([5, -1, 5]);
    expect(w.behaviour.curiosity.lureActive).toBe(true);
    const lure = [basin.maxX, basin.ground(basin.maxX, basin.maxZ), basin.maxZ];
    expect(Array.from(w.behaviour.curiosity.lure)).toEqual(lure);
    let followed = 0;
    for (let t = 0; t < seconds(20); t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        if (w.behaviour.curiosity.follow[i] !== 1) continue;
        followed++;
        expect(Array.from(w.behaviour.curiosity.seen.subarray(i * 3, i * 3 + 3))).toEqual(lure);
      }
    }
    expect(followed).toBeGreaterThan(0);
  });

  it('puts a lure dropped into sloped sand on the sand where it fell', () => {
    const w = new World({ seed: 3, space: SLOPED_SPACE, species: ARCHETYPES, decor: [], fish: [] });
    const { basin } = w;
    const drops: [Point3, number, number][] = [
      [[0, -1, 5], 0, basin.maxZ],
      [[0.2, -1, 0], 0.2, 0],
      [[-5, -1, -5], basin.minX, basin.minZ],
    ];
    for (const [drop, x, z] of drops) {
      w.setLure(drop);
      expect(Array.from(w.behaviour.curiosity.lure)).toEqual([x, basin.ground(x, z), z]);
      expect(basin.ground(x, z)).toBeGreaterThan(basin.minY);
    }
  });

  it('is deterministic: the same seed and lure path give the same trajectory', () => {
    const run = (): Float64Array => {
      const w = show([...spawnMany('angelfish', 3), ...spawnMany('betta', 1)], 9);
      for (let t = 0; t < seconds(30); t++) {
        w.setLure(t < seconds(20) ? [0.3 * Math.sin(t / 60), 0.25, FRONT] : null);
        w.step();
      }
      return w.position.slice();
    };
    expect(Array.from(run())).toEqual(Array.from(run()));
  });

  const reefIds = new Set(['blue-tang', 'yellow-tang', 'ocellaris-clownfish', 'royal-gramma']);
  it.each(
    ARCHETYPES.map((s) => ({
      id: s.id,
      reef: reefIds.has(s.id),
    })),
  )(
    'never penetrates glass or rock over 10 000 steps chasing a lure round the tank: $id',
    ({ id, reef }) => {
      const tank = reef ? REEF_TANK : SHOW_TANK;
      const front = tank.depth / 2 - 0.003;
      const steps = 10_000;
      const sweep = (lure: boolean) => {
        const w = new World({
          seed: 6,
          tank,
          species: ARCHETYPES,
          decor: reef ? REEF_DECOR : SHOW_DECOR,
          anchors: reef ? REEF_ANCHORS : [],
          fish: spawnMany(id, 4),
        });
        let worst = Infinity;
        let followed = 0;
        for (let t = 0; t < steps; t++) {
          const phase = t / seconds(30);
          if (lure) {
            w.setLure([
              0.45 * tank.width * Math.sin(2 * Math.PI * phase),
              tank.height * (0.5 + 0.4 * Math.sin(2 * Math.PI * 0.37 * phase)),
              front,
            ]);
          }
          w.step();
          followed += following(w);
          for (let i = 0; i < w.count; i++) worst = Math.min(worst, w.bodyClearance(i));
        }
        return { worst, followed, contactRate: w.contacts / (w.count * steps) };
      };
      const lured = sweep(true);
      expect(lured.worst).toBeGreaterThanOrEqual(-1e-9);
      expect(lured.followed).toBeGreaterThan(0);
      // Glass grazers touch the pane by design, so only the contacts the lure adds count, held to
      // half the budget of a feeding chase: a fish pivoting at stand-off may brush rock beside it.
      expect(lured.contactRate - sweep(false).contactRate).toBeLessThan(1e-3);
    },
  );
});

describe('feeding-spot memory', { timeout: LONG }, () => {
  const spot = { x: 0.4, z: 0.05 };
  const mealS = 300;

  function fed(seed: number): World {
    const w = show(spawnMany('angelfish', 4), seed);
    let id = 1;
    for (const meal of [0, mealS]) {
      while (w.time < meal) w.step();
      w.setFood(pinch(id, spot.x, spot.z));
      id += 10;
      w.step();
      w.setFood(new Float32Array(0));
    }
    return w;
  }

  function meanSpotDistance(w: World): number {
    let sum = 0;
    for (let i = 0; i < w.count; i++) {
      sum += Math.hypot(at(w.position, i * 3) - spot.x, at(w.position, i * 3 + 2) - spot.z);
    }
    return sum / w.count;
  }

  it('learns where food comes in and waits there as the next meal comes due', () => {
    const w = fed(3);
    for (let i = 0; i < w.count; i++) {
      expect(at(w.behaviour.curiosity.spot, i * 2)).toBeCloseTo(spot.x + 0.01, 5);
      expect(at(w.behaviour.curiosity.spot, i * 2 + 1)).toBeCloseTo(spot.z, 5);
    }
    const lead = CURIOSITY.anticipationLeadShare * mealS;
    while (w.time < 2 * mealS - lead - 30) {
      w.step();
      expect(Math.max(...w.behaviour.curiosity.anticipation)).toBe(0);
    }
    const before = meanSpotDistance(w);
    while (w.time < 2 * mealS) w.step();
    expect(Math.min(...w.behaviour.curiosity.anticipation)).toBeGreaterThan(0);
    const due = meanSpotDistance(w);
    expect(due).toBeLessThan(before);
    expect(due).toBeLessThan(
      2 * CURIOSITY.anticipationRadiusBodyLengths * angelfish.locomotion.bodyLengthM,
    );
    while (w.time < 2 * mealS + lead + 1) w.step();
    expect(Math.max(...w.behaviour.curiosity.anticipation)).toBe(0);
  });

  it('needs two meals to anticipate the next, and a newcomer knows no spot', () => {
    const w = show(spawnMany('angelfish', 2), 4);
    w.setFood(pinch(1, spot.x, spot.z));
    w.step();
    w.setFood(new Float32Array(0));
    for (let t = 0; t < seconds(600); t++) {
      w.step();
      expect(Math.max(...w.behaviour.curiosity.anticipation)).toBe(0);
    }
    const v = fed(5);
    v.addFish({ id: 'newcomer', species: 'angelfish' });
    const n = v.count - 1;
    while (v.time < 2 * mealS) v.step();
    expect(at(v.behaviour.curiosity.anticipation, n)).toBe(0);
    expect(at(v.behaviour.curiosity.anticipation, 0)).toBeGreaterThan(0);
  });
});
