import { benchmarkConfig, FoodRain, REEF_TANK } from '../src/fixtures.ts';
import { World, type WorldConfig } from '../src/world.ts';

// Host load only ever lengthens a step (preemption, a shared core, a cold cache), never shortens
// it. The sim is deterministic, so every replay of a scenario repeats the same work step for step,
// and the fastest of several replays of each step is close to its cost on an idle machine. The
// worst of 30 loaded swimming ratios is 1.45 with 9 replays against 1.54 with 5.
export const REPLAYS = 9;
export const WARMUP_STEPS = 150;
export const TIMED_STEPS = 300;
const REFERENCE_PASSES = 20;

export interface Scenario {
  /** Advances one step and returns the milliseconds the sim spent on it. */
  step(): number;
}

export function school(seed: number, fish = 60): WorldConfig {
  const config = benchmarkConfig(seed);
  return { ...config, fish: config.fish.slice(0, fish) };
}

export interface Swimming extends Scenario {
  readonly count: number;
}

export function swimming(seed: number, config = school(seed)): Swimming {
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
export function reference(): Scenario {
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

export interface Feeding extends Scenario {
  readonly particleSteps: number;
  readonly eaten: number;
}

export function flakes(count: number): (rain: FoodRain, tick: number) => void {
  return (rain, t) => rain.sprinkle('flakes', count, 0.4 * Math.sin(t), 0.1 * Math.cos(t), 0.5, 3);
}

/** A few hundred flakes and pellets in the water around the full school. */
export function frenzy(): Feeding {
  return feeding(school(2), 250, (rain, t) => {
    flakes(240)(rain, t);
    rain.sprinkle('pellets', 60, -0.3, 0, 0.3);
  });
}

/**
 * Feeds again whenever fewer than `cap` particles are in the water. Only the sim's share is timed
 * (taking the food buffer and stepping), not the stand-in for gameplay moving the food.
 */
export function feeding(
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
export function fastestMeanMs<const S extends readonly Scenario[]>(
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

export function at(values: ArrayLike<number>, i: number): number {
  const v = values[i];
  if (v === undefined) throw new Error(`no measurement ${i}`);
  return v;
}
