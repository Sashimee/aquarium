import { describe, expect, it } from 'vitest';
import {
  at,
  fastestMeanMs,
  feeding,
  flakes,
  frenzy,
  reference,
  school,
  swimming,
  TIMED_STEPS,
  WARMUP_STEPS,
  type Scenario,
} from '../scripts/benchScenarios.ts';
import { REEF_TANK, walkerBenchmarkConfig } from './fixtures.ts';
import type { SimToy } from './toys.ts';
import { WAVE_MAKER } from './waveMaker.ts';
import { World } from './world.ts';

const TEST_TIMEOUT_MS = 120_000;

// A slower machine (a shared CI runner) is still slower on an idle core, so the gate is on the
// ratio of the sim's cost to a fixed reference workload stepped in turn with it. Host load inflates
// that ratio, so each limit is the worst of 30 loaded runs on the budget desktop (Ryzen 5 7600X,
// Node 24, load average 20-32 on 10 cores, 2026-10-21: swimming 1.45, walking 2.25, feeding 2.91)
// with 1.3x headroom, of which 30 further loaded runs (peaks 1.54, 2.34, 3.09) leave 1.22-1.25x.
// The gate is therefore coarse: a sim slowdown up to about 1.4x passes a loaded run and up to
// about 1.5x a quiet one; a doubled cost failed all 30 loaded runs. A reference with a sim-sized
// working set (a 2 MB gather table) spread 1.35-2.5x between loaded runs, against 1.15-1.19x for
// the 60-point flock. Tight ratio limits for an idle machine are in scripts/bench.ts, which CI never
// runs, so a 1.2-1.4x slowdown is caught by nothing automated.
const HEADROOM = 1.3;
const SWIMMING_LIMIT = 1.45 * HEADROOM;
const WALKING_LIMIT = 2.25 * HEADROOM;
const FEEDING_LIMIT = 2.91 * HEADROOM;
// Toys cost a few distance checks per fish; a scan over every fish per fish would double it.
const TOYS_OVERHEAD_LIMIT = 1.3;
// The current costs a field sample and two SDF probes per fish, more only beside a surface or while
// sheltering: 1.20 on the budget desktop (2026-10-19, 0.27 ms against 0.22 ms a step). Doubling
// that extra work fails the limit.
const CURRENT_OVERHEAD_LIMIT = 1.4;

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
      const { meanMs, last } = fastestMeanMs(() => [frenzy(), reference()]);
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
