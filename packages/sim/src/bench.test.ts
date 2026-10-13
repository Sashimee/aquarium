import { describe, expect, it } from 'vitest';
import { benchmarkConfig, FoodRain, REEF_TANK } from './fixtures.ts';
import { World, type WorldConfig } from './world.ts';

// Host load only ever lengthens a step (preemption, a shared core, a cold cache), never shortens
// it. The sim is deterministic, so every replay of a scenario repeats the same work step for step,
// and the fastest of a few replays of each step is close to its cost on an idle machine.
const REPLAYS = 5;
const WARMUP_STEPS = 150;
const TIMED_STEPS = 300;
// 2 ms per step on desktop, and 4 ms under a 4x CPU throttle, which scales script time about
// linearly: the tighter of the two is 1 ms unthrottled.
const BUDGET_MS = Math.min(2, 4 / 4);
const TEST_TIMEOUT_MS = 120_000;

interface Scenario {
  /** Advances one step and returns the milliseconds the sim spent on it. */
  step(): number;
}

function timed(run: () => void): number {
  const t0 = performance.now();
  run();
  return performance.now() - t0;
}

function school(seed: number, fish = 60): WorldConfig {
  const config = benchmarkConfig(seed);
  return { ...config, fish: config.fish.slice(0, fish) };
}

function swimming(seed: number): Scenario {
  const world = new World(school(seed));
  return { step: () => timed(() => world.step()) };
}

interface Feeding extends Scenario {
  readonly particleSteps: number;
  readonly eaten: number;
}

/**
 * Feeds again whenever fewer than `cap` particles are in the water. Only the sim's share is timed
 * (taking the food buffer and stepping), not the stand-in for gameplay moving the food.
 */
function flakes(count: number): (rain: FoodRain, tick: number) => void {
  return (rain, t) => rain.sprinkle('flakes', count, 0.4 * Math.sin(t), 0.1 * Math.cos(t), 0.5, 3);
}

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
      ms += timed(() => world.setFood(buffer));
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
      ms += timed(() => world.step());
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
function fastestMeanMs<S extends Scenario>(
  make: () => readonly S[],
): { meanMs: number[]; last: readonly S[] } {
  let fastest: Float64Array[] = [];
  let last: readonly S[] = [];
  for (let replay = 0; replay < REPLAYS; replay++) {
    last = make();
    if (replay === 0) fastest = last.map(() => new Float64Array(TIMED_STEPS).fill(Infinity));
    for (let t = 0; t < WARMUP_STEPS; t++) for (const s of last) s.step();
    for (let t = 0; t < TIMED_STEPS; t++) {
      last.forEach((s, i) => {
        const best = fastest[i];
        if (best === undefined) throw new Error(`scenario ${i} appeared after the first replay`);
        best[t] = Math.min(best[t] ?? Infinity, s.step());
      });
    }
  }
  return {
    meanMs: fastest.map((best) => best.reduce((sum, ms) => sum + ms, 0) / TIMED_STEPS),
    last,
  };
}

function at(values: readonly number[], i: number): number {
  const v = values[i];
  if (v === undefined) throw new Error(`no measurement ${i}`);
  return v;
}

describe('step budget', () => {
  it(
    'steps 60 fish well inside the desktop and throttled budgets',
    () => {
      expect(new World(school(1)).count).toBe(60);
      const { meanMs } = fastestMeanMs(() => [swimming(1)]);
      expect(at(meanMs, 0)).toBeLessThan(BUDGET_MS);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stays inside the budget with a few hundred food particles in the water',
    () => {
      const { meanMs, last } = fastestMeanMs(() => [
        feeding(school(2), 250, (rain, t) => {
          flakes(240)(rain, t);
          rain.sprinkle('pellets', 60, -0.3, 0, 0.3);
        }),
      ]);
      const [fed] = last;
      if (fed === undefined) throw new Error('the feeding scenario did not run');
      expect(fed.particleSteps / (WARMUP_STEPS + TIMED_STEPS)).toBeGreaterThan(200);
      expect(fed.eaten).toBeGreaterThan(0);
      expect(at(meanMs, 0)).toBeLessThan(BUDGET_MS);
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
      if (sparse === undefined || dense === undefined) throw new Error('a scenario did not run');
      const particleRatio = dense.particleSteps / sparse.particleSteps;
      expect(particleRatio).toBeGreaterThan(10);
      expect(at(meanMs, 1) / at(meanMs, 0)).toBeLessThan(9);
    },
    TEST_TIMEOUT_MS,
  );
});
