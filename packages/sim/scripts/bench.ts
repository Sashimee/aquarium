import type { DecorCollider } from '../src/decor.ts';
import { benchmarkConfig, REEF_DECOR } from '../src/fixtures.ts';
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

// Dragging a rock: one collider moves every step, rebinning only its old and new cells.
const dragged = new World(benchmarkConfig(9));
const dragSteps = 600;
const dragStart = performance.now();
for (let i = 0; i < dragSteps; i++) {
  const x = -0.6 + (1.2 * i) / dragSteps;
  const decor: DecorCollider[] = REEF_DECOR.map((c) =>
    c.id === 'rock-left'
      ? { ...c, shape: { kind: 'sphere', center: [x, 0, 0.15], radius: 0.12 } }
      : c,
  );
  dragged.setDecor(decor);
  dragged.step();
}
const dragMean = (performance.now() - dragStart) / dragSteps;

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
    budgetMs: DESKTOP_BUDGET_MS,
    throttled4xEstimateMs: Number((THROTTLE * mean).toFixed(4)),
    throttled4xP99EstimateMs: Number((THROTTLE * percentile(samples, 0.99)).toFixed(4)),
    throttledBudgetMs: THROTTLED_BUDGET_MS,
    draggingDecorMeanMsPerStep: Number(dragMean.toFixed(4)),
  }),
);
