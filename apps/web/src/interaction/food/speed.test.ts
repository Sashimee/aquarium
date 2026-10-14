import { speciesSchema } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { sampleCurrent, type CurrentParameters } from '../../scene/current';
import { FoodField } from './particles';
import { FOOD_PROFILES, FOOD_TYPES } from './profiles';

const species = Object.values(
  import.meta.glob('../../../../../content/species/*.json', { eager: true, import: 'default' }),
).map((raw) => speciesSchema.partial({ render: true }).parse(raw));

const presets = Object.entries(
  import.meta.glob('../../../../../content/presets/*.json', { eager: true, import: 'default' }),
)
  .map(([path, raw]) => ({ path, current: (raw as { current?: CurrentParameters }).current }))
  .filter((p): p is { path: string; current: CurrentParameters } => p.current !== undefined);

/** Food may use at most this share of the slowest eater's cruise speed, so it can be caught. */
const CATCHABLE_SHARE = 0.6;

function slowestEaterCruise(food: (typeof FOOD_TYPES)[number]): number {
  const eaters = species.filter((s) => s.lifecycle.diet.includes(food));
  expect(eaters.length, food).toBeGreaterThan(0);
  return Math.min(...eaters.map((s) => s.locomotion.cruiseSpeedMps));
}

describe('food speed against its eaters', () => {
  it.each(FOOD_TYPES)('%s sinks and drifts slower than its slowest eater cruises', (food) => {
    const profile = FOOD_PROFILES[food];
    const limit = slowestEaterCruise(food) * CATCHABLE_SHARE;
    expect(Math.hypot(profile.sinkSpeed, profile.maxDriftS)).toBeLessThanOrEqual(limit);
  });

  it('ships presets with a current to test against', () => {
    expect(presets.length).toBeGreaterThan(0);
  });

  describe.each(presets)('in the $path current', ({ current }) => {
    it.each(FOOD_TYPES)('%s never moves faster than its slowest eater cruises', (food) => {
      let time = 0;
      const field = new FoodField({
        bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5, waterTop: 5 },
        groundHeight: () => 0,
        current: (x, y, z, out) => sampleCurrent(current, x, y, z, time, out),
      });
      field.drop(food, 1, 0, 0, 0.05);
      const dt = 1 / 30;
      const limit = slowestEaterCruise(food) * CATCHABLE_SHARE;
      const last = new Map(field.particles.map((p) => [p.id, [p.x, p.y, p.z]] as const));
      let fastest = 0;
      for (; time < 120; time += dt) {
        field.step(dt);
        for (const p of field.particles) {
          const from = last.get(p.id) ?? [p.x, p.y, p.z];
          if (p.ageS > dt) {
            fastest = Math.max(
              fastest,
              Math.hypot(p.x - (from[0] ?? 0), p.y - (from[1] ?? 0), p.z - (from[2] ?? 0)) / dt,
            );
          }
          last.set(p.id, [p.x, p.y, p.z]);
        }
      }
      expect(fastest).toBeGreaterThan(0);
      expect(fastest).toBeLessThanOrEqual(limit);
    });
  });
});
