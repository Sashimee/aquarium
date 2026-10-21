import { describe, expect, it } from 'vitest';
import { benchmarkConfig, FoodRain, REEF_TANK, walkerBenchmarkConfig } from './fixtures.ts';
import type { SimToy } from './toys.ts';
import { WAVE_MAKER } from './waveMaker.ts';
import { World, type WorldConfig } from './world.ts';

// Host load only ever lengthens a step (preemption, a shared core, a cold cache), never shortens
// it. The sim is deterministic, so every replay of a scenario repeats the same work step for step,
// and the fastest of several replays of each step is close to its cost on an idle machine. Under
// load, 9 replays bring the worst of 30 swimming ratios from 1.54 (5 replays) to 1.45.
const REPLAYS = 9;
const WARMUP_STEPS = 150;
const TIMED_STEPS = 300;
const TEST_TIMEOUT_MS = 120_000;

// A slower machine (a shared CI runner) is still slower on an idle core, so the sim is timed
// against a fixed reference workload stepped in turn with it, and the gate is on their ratio. The
// reference's 60 points stay in L1 while the sim's working set is far larger, so under load the sim
// slows more than the reference and the fastest replay cannot remove that. The limits are
// therefore the worst ratio of 30 runs on the budget desktop (Ryzen 5 7600X, Node 24, 2026-10-21)
// with a full `vitest run` of the repo in parallel and load average 20-32 on 10 cores: swimming
// 1.25-1.45 (median 1.33), 20 shrimp walking 1.82-2.25 (1.96), feeding 2.44-2.91 (2.67). Times
// 1.3 for how differently other CPUs and V8 builds weigh the sim's mix of work against the
// reference's (CI measured 1.61 swimming with 5 replays); 30 more loaded runs peaked at 1.54, 2.34
// and 3.09. Stepping a second world inside the timed span, a doubled sim cost, failed all 30 loaded
// runs, at no less than 2.32, 3.51 and 4.79 against limits of 1.89, 2.93 and 3.78. The absolute
// 2 ms / 4 ms-at-4x-throttle budgets are gated by `pnpm --filter @aquarium/sim bench`.
const HEADROOM = 1.3;
const SWIMMING_LIMIT = 1.45 * HEADROOM;
const WALKING_LIMIT = 2.25 * HEADROOM;
const FEEDING_LIMIT = 2.91 * HEADROOM;
const REFERENCE_PASSES = 20;
// Toys cost a few distance checks per fish; a scan over every fish per fish would double it.
const TOYS_OVERHEAD_LIMIT = 1.3;
// The current costs a field sample and two SDF probes per fish, more only beside a surface or while
// sheltering: 1.20 on the budget desktop (2026-10-19, 0.27 ms against 0.22 ms a step). Doubling
// that extra work fails the limit.
const CURRENT_OVERHEAD_LIMIT = 1.4;

interface Scenario {
  /** Advances one step and returns the milliseconds the sim spent on it. */
  step(): number;
}

function school(seed: number, fish = 60): WorldConfig {
  const config = benchmarkConfig(seed);
  return { ...config, fish: config.fish.slice(0, fish) };
}

interface Swimming extends Scenario {
  readonly count: number;
}

function swimming(seed: number, config = school(seed)): Swimming {
  const world = new World(config);
  return {
    count: world.count,
    step(): number {
      const t0 = performance.now();
      world.step();
      return performance.now() - t0;
    },
  };
}

const REFERENCE_POINTS = 60;
const REFERENCE_NEIGHBOURS = 7;

/**
 * A topological-neighbour flocking pass written independently of the sim, so a regression in the
 * sim's code cannot slow it too: every point finds its nearest few and turns and moves with trig
 * and square roots, the same mix of work as a sim step.
 */
function flockPass(pos: Float64Array, heading: Float64Array, nearest: Float64Array): void {
  const n = REFERENCE_POINTS;
  const k = REFERENCE_NEIGHBOURS;
  for (let i = 0; i < n; i++) {
    const ix = pos[i * 3] ?? 0;
    const iy = pos[i * 3 + 1] ?? 0;
    const iz = pos[i * 3 + 2] ?? 0;
    let found = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = (pos[j * 3] ?? 0) - ix;
      const dy = (pos[j * 3 + 1] ?? 0) - iy;
      const dz = (pos[j * 3 + 2] ?? 0) - iz;
      const d = dx * dx + dy * dy + dz * dz;
      if (found === k && d >= (nearest[k - 1] ?? Infinity)) continue;
      let slot = found < k ? found++ : k - 1;
      while (slot > 0 && (nearest[slot - 1] ?? Infinity) > d) {
        nearest[slot] = nearest[slot - 1] ?? Infinity;
        slot--;
      }
      nearest[slot] = d;
      cx += dx;
      cy += dy;
      cz += dz;
    }
    const len = Math.sqrt(cx * cx + cy * cy + cz * cz) + 1e-9;
    const h = (heading[i] ?? 0) + 0.1 * Math.sin(Math.atan2(cx, cz) - (heading[i] ?? 0));
    heading[i] = h;
    pos[i * 3] = Math.max(-0.5, Math.min(0.5, ix + 0.003 * (Math.sin(h) + cx / len)));
    pos[i * 3 + 1] = Math.max(-0.5, Math.min(0.5, iy + (0.003 * cy) / len));
    pos[i * 3 + 2] = Math.max(-0.5, Math.min(0.5, iz + 0.003 * (Math.cos(h) + cz / len)));
  }
}

// Every scenario times its own work inline. A shared timing helper's call site sees every
// scenario's closures, and how V8 inlined that megamorphic call shifted the reference's cost by up
// to 30% between runs.
function reference(): Scenario {
  const pos = new Float64Array(REFERENCE_POINTS * 3);
  const heading = new Float64Array(REFERENCE_POINTS);
  const nearest = new Float64Array(REFERENCE_NEIGHBOURS);
  let lcg = 12345;
  for (let i = 0; i < pos.length; i++) {
    lcg = (Math.imul(lcg, 1103515245) + 12345) >>> 0;
    pos[i] = lcg / 2 ** 32 - 0.5;
  }
  return {
    step(): number {
      const t0 = performance.now();
      for (let p = 0; p < REFERENCE_PASSES; p++) flockPass(pos, heading, nearest);
      return performance.now() - t0;
    },
  };
}

/**
 * The school with a mirror on the back glass and a ball drifting on the surface, resent every step
 * as gameplay does while it moves, the bumps fed back into its drift.
 */
function playing(seed: number): Scenario {
  const world = new World(school(seed));
  const back = -REEF_TANK.depth / 2 + 0.004;
  const ball = { x: 0, z: 0, vx: 0.05, vz: 0.03 };
  return {
    step(): number {
      const toys: SimToy[] = [
        { kind: 'mirror', position: [0.2, 0.45, back], normal: [0, 0, 1] },
        {
          kind: 'ball',
          position: [ball.x, REEF_TANK.height + 0.012, ball.z],
          velocity: [ball.vx, 0, ball.vz],
        },
      ];
      const t0 = performance.now();
      world.setToys(toys);
      world.step();
      const ms = performance.now() - t0;
      for (const n of world.takeToyNudges()) {
        ball.vx += n.ix;
        ball.vz += n.iz;
      }
      ball.x += ball.vx / 30;
      ball.z += ball.vz / 30;
      if (Math.abs(ball.x) > REEF_TANK.width / 2 - 0.03) ball.vx = -ball.vx;
      if (Math.abs(ball.z) > REEF_TANK.depth / 2 - 0.03) ball.vz = -ball.vz;
      return ms;
    },
  };
}

interface Feeding extends Scenario {
  readonly particleSteps: number;
  readonly eaten: number;
}

function flakes(count: number): (rain: FoodRain, tick: number) => void {
  return (rain, t) => rain.sprinkle('flakes', count, 0.4 * Math.sin(t), 0.1 * Math.cos(t), 0.5, 3);
}

/**
 * Feeds again whenever fewer than `cap` particles are in the water. Only the sim's share is timed
 * (taking the food buffer and stepping), not the stand-in for gameplay moving the food.
 */
function feeding(
  config: WorldConfig,
  cap: number,
  feed: (rain: FoodRain, tick: number) => void,
): Feeding {
  const world = new World(config);
  const rain = new FoodRain(REEF_TANK);
  let tick = 0;
  let particleSteps = 0;
  let ms = 0;
  const sim = {
    substrateSdf: world.substrateSdf,
    setFood(buffer: Float32Array): void {
      const t0 = performance.now();
      world.setFood(buffer);
      ms += performance.now() - t0;
      particleSteps += buffer.length / 5;
    },
  };
  return {
    get particleSteps() {
      return particleSteps;
    },
    get eaten() {
      return rain.eaten;
    },
    step(): number {
      const t = tick++;
      if (rain.count < cap) feed(rain, t);
      ms = 0;
      rain.feed(sim);
      const t0 = performance.now();
      world.step();
      ms += performance.now() - t0;
      rain.eat(world.takeAteEvents());
      return ms;
    },
  };
}

/**
 * Replays the scenarios side by side, so a stretch of heavy load hits all of them alike, and
 * returns each one's mean over the timed steps of its fastest replay of every step, with the last
 * replay's scenarios.
 */
function fastestMeanMs<const S extends readonly Scenario[]>(
  make: () => S,
): { meanMs: number[]; last: S } {
  let fastest: Float64Array[] = [];
  let last = make();
  for (let replay = 0; replay < REPLAYS; replay++) {
    if (replay > 0) last = make();
    if (replay === 0) fastest = last.map(() => new Float64Array(TIMED_STEPS).fill(Infinity));
    for (let t = 0; t < WARMUP_STEPS; t++) for (const s of last) s.step();
    for (let t = 0; t < TIMED_STEPS; t++) {
      last.forEach((s, i) => {
        const best = fastest[i];
        if (best === undefined) throw new Error(`scenario ${i} appeared after the first replay`);
        best[t] = Math.min(at(best, t), s.step());
      });
    }
  }
  return {
    meanMs: fastest.map((best) => best.reduce((sum, ms) => sum + ms, 0) / TIMED_STEPS),
    last,
  };
}

function at(values: ArrayLike<number>, i: number): number {
  const v = values[i];
  if (v === undefined) throw new Error(`no measurement ${i}`);
  return v;
}

describe('step budget', () => {
  it(
    'steps 60 fish inside the budget relative to the reference workload',
    () => {
      const { meanMs, last } = fastestMeanMs(() => [swimming(1), reference()]);
      const [swim] = last;
      expect(swim.count).toBe(60);
      expect(at(meanMs, 0) / at(meanMs, 1)).toBeLessThan(SWIMMING_LIMIT);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'steps 60 fish and 20 walking shrimp inside the budget relative to the reference workload',
    () => {
      const { meanMs, last } = fastestMeanMs(() => [
        swimming(4, walkerBenchmarkConfig(4)),
        reference(),
      ]);
      const [mixed] = last;
      expect(mixed.count).toBe(80);
      expect(at(meanMs, 0) / at(meanMs, 1)).toBeLessThan(WALKING_LIMIT);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stays inside the relative budget with a few hundred food particles in the water',
    () => {
      const { meanMs, last } = fastestMeanMs(() => [
        feeding(school(2), 250, (rain, t) => {
          flakes(240)(rain, t);
          rain.sprinkle('pellets', 60, -0.3, 0, 0.3);
        }),
        reference(),
      ]);
      const [fed] = last;
      expect(fed.particleSteps / (WARMUP_STEPS + TIMED_STEPS)).toBeGreaterThan(200);
      expect(fed.eaten).toBeGreaterThan(0);
      expect(at(meanMs, 0) / at(meanMs, 1)).toBeLessThan(FEEDING_LIMIT);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'adds little to a step with a mirror and a drifting ball in the tank',
    () => {
      const { meanMs } = fastestMeanMs(() => [playing(5), swimming(5)]);
      expect(at(meanMs, 0) / at(meanMs, 1)).toBeLessThan(TOYS_OVERHEAD_LIMIT);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'adds little to a step with a full-power wave maker running',
    () => {
      const current = {
        ...school(6),
        waveMaker: {
          direction: [1, 0] as const,
          speedMps: WAVE_MAKER.maxSpeedMps,
          mode: 'steady' as const,
          periodS: WAVE_MAKER.pulsePeriodS,
        },
      };
      const { meanMs } = fastestMeanMs(() => [swimming(6, current), swimming(6)]);
      expect(at(meanMs, 0) / at(meanMs, 1)).toBeLessThan(CURRENT_OVERHEAD_LIMIT);
    },
    TEST_TIMEOUT_MS,
  );

  // Both worlds step in turn, so whatever the host does to one it does to the other and their cost
  // ratio is independent of load. A small school keeps fish behaviour from drowning out the food
  // handling. The ratio is about 6 for 15 times the particles; a nested-loop id-uniqueness check in
  // FoodStore's validation, O(n^2) in particles, pushes it to about 14.
  it(
    'grows food handling cost no faster than the number of particles',
    () => {
      const { meanMs, last } = fastestMeanMs(() => [
        feeding(school(3, 8), 40, flakes(40)),
        feeding(school(3, 8), 700, flakes(300)),
      ]);
      const [sparse, dense] = last;
      const particleRatio = dense.particleSteps / sparse.particleSteps;
      expect(particleRatio).toBeGreaterThan(10);
      expect(at(meanMs, 1) / at(meanMs, 0)).toBeLessThan(9);
    },
    TEST_TIMEOUT_MS,
  );
});
