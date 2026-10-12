import { benchmarkConfig } from '../src/fixtures.ts';
import { World } from '../src/world.ts';

const WARMUP_STEPS = 300;
const MEASURED_STEPS = 3000;
const RUNS = 5;

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

samples.sort((a, b) => a - b);
const mean = means.reduce((a, b) => a + b, 0) / means.length;
console.log(
  JSON.stringify({
    fish: benchmarkConfig(0).fish.length,
    steps: RUNS * MEASURED_STEPS,
    meanMsPerStep: Number(mean.toFixed(4)),
    p50Ms: Number(percentile(samples, 0.5).toFixed(4)),
    p99Ms: Number(percentile(samples, 0.99).toFixed(4)),
    maxMs: Number(percentile(samples, 1).toFixed(4)),
    budgetMs: 2,
  }),
);
