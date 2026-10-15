import type { Collider } from '@aquarium/shared';
import {
  benchmarkConfig,
  FoodRain,
  REEF_DECOR,
  REEF_TANK,
  walkerBenchmarkConfig,
} from '../src/fixtures.ts';
import { World } from '../src/world.ts';

const WARMUP_STEPS = 300;
const MEASURED_STEPS = 3000;
const RUNS = 5;
// Chrome DevTools' 4x CPU throttle slows script roughly linearly; the bench runs unthrottled in
// Node, so the throttled figure is this multiple of the measured one.
const THROTTLE = 4;
const DESKTOP_BUDGET_MS = 2;
const THROTTLED_BUDGET_MS = 4;

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
}

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

samples.sort((a, b) => a - b);
feedSamples.sort((a, b) => a - b);
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
  }),
);

const gates: [string, number][] = [
  ['p99 step', percentile(samples, 0.99)],
  ['p99 feeding step', percentile(feedSamples, 0.99)],
  ['p99 step with walkers', percentile(walkerSamples, 0.99)],
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
if (over.length > 0) {
  throw new Error(
    `${over.join('\n')}\nRerun on an idle machine before treating this as a regression.`,
  );
}
