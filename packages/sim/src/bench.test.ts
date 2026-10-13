import { describe, expect, it } from 'vitest';
import { benchmarkConfig, FoodRain, REEF_TANK } from './fixtures.ts';
import { World, type WorldConfig } from './world.ts';

// Host load only ever lengthens a step (preemption, a shared core, a cold cache), never shortens
// it. The sim is deterministic, so every replay of a scenario repeats the same work step for step,
// and the fastest of a few replays of each step is close to its cost on an idle machine.
const REPLAYS = 5;
const WARMUP_STEPS = 150;
const TIMED_STEPS = 300;
const TEST_TIMEOUT_MS = 120_000;

// A slower machine (a shared CI runner) is still slower on an idle core, so the sim is timed
// against a fixed reference workload stepped in turn with it, and the gate is on their ratio. The
// limits are the ratios measured on the desktop the 2 ms / 4 ms-at-4x-throttle budgets were set
// on (Ryzen 5 7600X, Node 24: 1.15 swimming, 1.95 feeding), times 1.4 for how differently other
// CPUs and V8 builds weigh the sim's mix of work against the reference's. A sim twice as slow is
// still well past the limit. The absolute budgets are gated by `pnpm --filter @aquarium/sim bench`.
const HEADROOM = 1.4;
const SWIMMING_LIMIT = 1.15 * HEADROOM;
const FEEDING_LIMIT = 1.95 * HEADROOM;
const REFERENCE_PASSES = 20;

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

interface Swimming extends Scenario {
  readonly count: number;
}

function swimming(seed: number): Swimming {
  const world = new World(school(seed));
  return { count: world.count, step: () => timed(() => world.step()) };
}

/**
 * A topological-neighbour flocking pass written independently of the sim, so a regression in the
 * sim's code cannot slow it too: 60 points each find their 7 nearest and turn and move with trig
 * and square roots, the same mix of work as a sim step, at about the same cost.
 */
function reference(): Scenario {
  const n = 60;
  const k = 7;
  const pos = new Float64Array(n * 3);
  const heading = new Float64Array(n);
  const nearest = new Float64Array(k);
  let lcg = 12345;
  for (let i = 0; i < pos.length; i++) {
    lcg = (Math.imul(lcg, 1103515245) + 12345) >>> 0;
    pos[i] = lcg / 2 ** 32 - 0.5;
  }
  const pass = (): void => {
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
  };
  return {
    step: () =>
      timed(() => {
        for (let p = 0; p < REFERENCE_PASSES; p++) pass();
      }),
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
    'steps 60 fish well inside the desktop and throttled budgets',
    () => {
      const { meanMs, last } = fastestMeanMs(() => [swimming(1), reference()]);
      const [swim] = last;
      expect(swim.count).toBe(60);
      process.stderr.write(
        `RATIO swim ${(at(meanMs, 0) / at(meanMs, 1)).toFixed(3)} sim ${at(meanMs, 0).toFixed(4)}\n`,
      );
      expect(at(meanMs, 0) / at(meanMs, 1)).toBeLessThan(SWIMMING_LIMIT);
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
        reference(),
      ]);
      const [fed] = last;
      expect(fed.particleSteps / (WARMUP_STEPS + TIMED_STEPS)).toBeGreaterThan(200);
      expect(fed.eaten).toBeGreaterThan(0);
      process.stderr.write(
        `RATIO feed ${(at(meanMs, 0) / at(meanMs, 1)).toFixed(3)} sim ${at(meanMs, 0).toFixed(4)}\n`,
      );
      expect(at(meanMs, 0) / at(meanMs, 1)).toBeLessThan(FEEDING_LIMIT);
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
      process.stderr.write(`RATIO dense ${(at(meanMs, 1) / at(meanMs, 0)).toFixed(3)}\n`);
      expect(at(meanMs, 1) / at(meanMs, 0)).toBeLessThan(9);
    },
    TEST_TIMEOUT_MS,
  );
});
