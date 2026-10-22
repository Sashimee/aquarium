import type { Collider } from '@aquarium/shared';
import {
  benchmarkConfig,
  FoodRain,
  REEF_DECOR,
  REEF_TANK,
  walkerBenchmarkConfig,
} from '../src/fixtures.ts';
import { World } from '../src/world.ts';
import { at, fastestMeanMs, frenzy, reference, swimming, type Scenario } from './benchScenarios.ts';

const WARMUP_STEPS = 300;
const MEASURED_STEPS = 3000;
const RUNS = 5;
// Chrome DevTools' 4x CPU throttle slows script roughly linearly; the bench runs unthrottled in
// Node, so the throttled figure is this multiple of the measured one.
const THROTTLE = 4;
const DESKTOP_BUDGET_MS = 2;
const THROTTLED_BUDGET_MS = 4;
// Worst of 10 runs on the budget desktop at load average 3-8 (Ryzen 5 7600X, Node 24, 2026-10-22):
// swimming 1.137-1.163, walking 1.743-1.783, feeding 2.247-2.358, times 1.15. A clean process
// keeps the ratio far steadier than under vitest: a sim slowdown fails here from 1.15x at the slow
// end of each range and from 1.18-1.21x at the fast end.
const REFERENCE_RATIO_LIMITS = { swimming: 1.34, walking: 2.05, feeding: 2.71 } as const;

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
}

// Reported, not gated: a scavenge landing inside a step is what a p99 spike usually is, and this
// tells a reader whether the hot loop allocates before they chase it.
const gcPauses: PerformanceEntry[] = [];
const gc = new PerformanceObserver((list) => gcPauses.push(...list.getEntries()));
gc.observe({ entryTypes: ['gc'] });

const means: number[] = [];
const samples: number[] = [];
for (let run = 0; run < RUNS; run++) {
  const world = new World(benchmarkConfig(run + 1));
  for (let i = 0; i < WARMUP_STEPS; i++) world.step();
  const start = performance.now();
  for (let i = 0; i < MEASURED_STEPS; i++) {
    const t0 = performance.now();
    world.step();
    samples.push(performance.now() - t0);
  }
  means.push((performance.now() - start) / MEASURED_STEPS);
}

// The same 60 fish with 20 cherry shrimp walking the reef floor.
const walkerSamples: number[] = [];
let walkerMs = 0;
for (let run = 0; run < RUNS; run++) {
  const world = new World(walkerBenchmarkConfig(run + 1));
  for (let i = 0; i < WARMUP_STEPS; i++) world.step();
  for (let i = 0; i < MEASURED_STEPS; i++) {
    const t0 = performance.now();
    world.step();
    const ms = performance.now() - t0;
    walkerSamples.push(ms);
    walkerMs += ms;
  }
}
const walkerMean = walkerMs / (RUNS * MEASURED_STEPS);

// Dragging a rock: one collider moves every step, rebinning only its old and new cells.
const dragged = new World(benchmarkConfig(9));
const dragSteps = 600;
const dragStart = performance.now();
for (let i = 0; i < dragSteps; i++) {
  const x = -0.6 + (1.2 * i) / dragSteps;
  const decor: Collider[] = REEF_DECOR.map((c) =>
    c.id === 'rock-left'
      ? { id: c.id, hard: c.hard, kind: 'sphere', center: [x, 0, 0.15], radius: 0.12 }
      : c,
  );
  dragged.setDecor(decor);
  dragged.step();
}
const dragMean = (performance.now() - dragStart) / dragSteps;

// A feeding frenzy: a few hundred particles in the water while every fish hunts. Only the sim's
// share is timed (taking the food buffer and stepping), not the test harness moving the food.
const fed = new World(benchmarkConfig(10));
const rain = new FoodRain(REEF_TANK);
const feedSteps = 3000;
let feedMs = 0;
let stepFeedMs = 0;
let particleSteps = 0;
const feedSamples: number[] = [];
const timedWorld = {
  substrateSdf: fed.substrateSdf,
  setFood(buffer: Float32Array): void {
    const t0 = performance.now();
    fed.setFood(buffer);
    stepFeedMs += performance.now() - t0;
    particleSteps += buffer.length / 5;
  },
};
for (let i = 0; i < feedSteps; i++) {
  if (rain.count < 200) {
    rain.sprinkle('flakes', 240, 0.4 * Math.sin(i), 0.1 * Math.cos(i), 0.5, 3);
    rain.sprinkle('pellets', 60, -0.3, 0, 0.3);
  }
  stepFeedMs = 0;
  rain.feed(timedWorld);
  const t0 = performance.now();
  fed.step();
  stepFeedMs += performance.now() - t0;
  feedMs += stepFeedMs;
  feedSamples.push(stepFeedMs);
  rain.eat(fed.takeAteEvents());
}
const feedMean = feedMs / feedSteps;

// Toys in the reef: a mirror on the back glass and a ball drifting on the surface, resent every
// step as gameplay does while it moves, with the bumps fed back into its drift.
const played = new World(benchmarkConfig(11));
const back = -REEF_TANK.depth / 2 + 0.004;
const ball = { x: 0, z: 0, vx: 0.05, vz: 0.03 };
const toySteps = 3000;
let toyMs = 0;
const toySamples: number[] = [];
for (let i = 0; i < toySteps; i++) {
  const t0 = performance.now();
  played.setToys([
    { kind: 'mirror', position: [0.2, 0.45, back], normal: [0, 0, 1] },
    {
      kind: 'ball',
      position: [ball.x, REEF_TANK.height + 0.012, ball.z],
      velocity: [ball.vx, 0, ball.vz],
    },
  ]);
  played.step();
  const ms = performance.now() - t0;
  toyMs += ms;
  toySamples.push(ms);
  for (const n of played.takeToyNudges()) {
    ball.vx += n.ix;
    ball.vz += n.iz;
  }
  ball.x += ball.vx / 30;
  ball.z += ball.vz / 30;
  if (Math.abs(ball.x) > REEF_TANK.width / 2 - 0.03) ball.vx = -ball.vx;
  if (Math.abs(ball.z) > REEF_TANK.depth / 2 - 0.03) ball.vz = -ball.vz;
}
const toyMean = toyMs / toySteps;

// Node queues gc entries to the observer only once the event loop turns.
await new Promise((resolve) => setTimeout(resolve, 0));
gc.disconnect();
const gcMs = gcPauses.reduce((sum, e) => sum + e.duration, 0);

function ratioToReference(make: () => readonly [Scenario, Scenario]): number {
  const { meanMs } = fastestMeanMs(make);
  return at(meanMs, 0) / at(meanMs, 1);
}

const ratios = {
  swimming: ratioToReference(() => [swimming(1), reference()]),
  walking: ratioToReference(() => [swimming(4, walkerBenchmarkConfig(4)), reference()]),
  feeding: ratioToReference(() => [frenzy(), reference()]),
};

samples.sort((a, b) => a - b);
feedSamples.sort((a, b) => a - b);
toySamples.sort((a, b) => a - b);
walkerSamples.sort((a, b) => a - b);
const mean = means.reduce((a, b) => a + b, 0) / means.length;
console.log(
  JSON.stringify({
    fish: benchmarkConfig(0).fish.length,
    steps: RUNS * MEASURED_STEPS,
    meanMsPerStep: Number(mean.toFixed(4)),
    p50Ms: Number(percentile(samples, 0.5).toFixed(4)),
    p99Ms: Number(percentile(samples, 0.99).toFixed(4)),
    maxMs: Number(percentile(samples, 1).toFixed(4)),
    budgetMs: DESKTOP_BUDGET_MS,
    throttled4xEstimateMs: Number((THROTTLE * mean).toFixed(4)),
    throttled4xP99EstimateMs: Number((THROTTLE * percentile(samples, 0.99)).toFixed(4)),
    throttledBudgetMs: THROTTLED_BUDGET_MS,
    withWalkers: walkerBenchmarkConfig(0).fish.length,
    withWalkersMeanMsPerStep: Number(walkerMean.toFixed(4)),
    withWalkersP99Ms: Number(percentile(walkerSamples, 0.99).toFixed(4)),
    draggingDecorMeanMsPerStep: Number(dragMean.toFixed(4)),
    feedingMeanParticles: Math.round(particleSteps / feedSteps),
    feedingMeanMsPerStep: Number(feedMean.toFixed(4)),
    feedingP99Ms: Number(percentile(feedSamples, 0.99).toFixed(4)),
    withToysMeanMsPerStep: Number(toyMean.toFixed(4)),
    withToysP99Ms: Number(percentile(toySamples, 0.99).toFixed(4)),
    swimmingToReference: Number(ratios.swimming.toFixed(4)),
    walkingToReference: Number(ratios.walking.toFixed(4)),
    feedingToReference: Number(ratios.feeding.toFixed(4)),
    gcPauses: gcPauses.length,
    gcPauseMs: Number(gcMs.toFixed(4)),
  }),
);

const gates: [string, number][] = [
  ['p99 step', percentile(samples, 0.99)],
  ['p99 feeding step', percentile(feedSamples, 0.99)],
  ['p99 step with walkers', percentile(walkerSamples, 0.99)],
  ['p99 step with toys', percentile(toySamples, 0.99)],
];
const over: string[] = [];
for (const [name, ms] of gates) {
  if (ms > DESKTOP_BUDGET_MS) {
    over.push(`${name} ${ms.toFixed(3)} ms is over the ${DESKTOP_BUDGET_MS} ms desktop budget`);
  }
  if (THROTTLE * ms > THROTTLED_BUDGET_MS) {
    over.push(
      `${name} ${(THROTTLE * ms).toFixed(3)} ms at ${THROTTLE}x throttle is over the ${THROTTLED_BUDGET_MS} ms budget`,
    );
  }
}
for (const name of ['swimming', 'walking', 'feeding'] as const) {
  if (!(ratios[name] <= REFERENCE_RATIO_LIMITS[name])) {
    over.push(
      `${name} step ${ratios[name].toFixed(3)}x the reference workload is over the ${REFERENCE_RATIO_LIMITS[name]}x limit`,
    );
  }
}
if (over.length > 0) {
  throw new Error(
    `${over.join('\n')}\nRerun on an idle machine before treating this as a regression.`,
  );
}
