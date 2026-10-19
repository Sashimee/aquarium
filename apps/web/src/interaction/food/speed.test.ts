import { speciesSchema } from '@aquarium/shared';
import { FEEDING } from '@aquarium/sim';
import { describe, expect, it } from 'vitest';
import { normaliseDirection, sampleCurrent, type CurrentParameters } from '../../scene/current';
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

function slowestEaterCruise(food: (typeof FOOD_TYPES)[number]): number {
  // Shelled walkers (snail, hermit crab) graze food that has settled; they never strike drifting food.
  const eaters = species.filter(
    (s) => s.lifecycle.diet.includes(food) && s.locomotion.swimmingMode !== 'none',
  );
  expect(eaters.length, food).toBeGreaterThan(0);
  return Math.min(...eaters.map((s) => s.locomotion.cruiseSpeedMps));
}

describe('food speed against its eaters', () => {
  it.each(FOOD_TYPES)('%s drifts sideways slower than its slowest eater can strike', (food) => {
    const limit = slowestEaterCruise(food) * FEEDING.strikeSpeedFactor;
    expect(FOOD_PROFILES[food].maxDriftS).toBeLessThan(limit);
  });

  it('sinks wafers faster than pellets, pellets faster than bloodworms, then flakes and shrimp', () => {
    const sink = (food: (typeof FOOD_TYPES)[number]) => FOOD_PROFILES[food].sinkSpeed;
    expect(sink('algae-wafer')).toBeGreaterThanOrEqual(0.06);
    expect(sink('pellets')).toBeGreaterThanOrEqual(0.02);
    expect(sink('pellets')).toBeLessThanOrEqual(0.04);
    expect(sink('algae-wafer')).toBeGreaterThan(sink('pellets'));
    expect(sink('pellets')).toBeGreaterThan(sink('bloodworms'));
    expect(sink('bloodworms')).toBeGreaterThan(sink('flakes'));
    expect(sink('bloodworms')).toBeGreaterThan(sink('brine-shrimp'));
  });

  it('drifts lighter food at least as far as heavier food at the preset currents', () => {
    const drift = (food: (typeof FOOD_TYPES)[number]): number => {
      const field = new FoodField(
        {
          bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5, waterTop: 5 },
          groundHeight: () => -5,
          current: (_x, _y, _z, out) => {
            out[0] = 0.12;
            out[1] = 0;
            out[2] = 0;
          },
        },
        () => 0,
      );
      field.drop(food, 0.05, 0, 0, 0);
      for (let t = 0; t < 4; t += 1 / 30) field.step(1 / 30);
      return field.particles[0]?.x ?? 0;
    };
    expect(drift('brine-shrimp')).toBeGreaterThanOrEqual(drift('bloodworms') - 1e-9);
    expect(drift('flakes')).toBeGreaterThanOrEqual(drift('bloodworms') - 1e-9);
    expect(drift('bloodworms')).toBeGreaterThanOrEqual(drift('pellets') - 1e-9);
  });

  it('ships presets with a current to test against', () => {
    expect(presets.length).toBeGreaterThan(0);
  });

  describe.each(presets)('in the $path current', ({ current }) => {
    it.each(FOOD_TYPES)(
      '%s never drifts or rises faster than its slowest eater can strike',
      (food) => {
        const params = { ...current, direction: normaliseDirection(current.direction) };
        let time = 0;
        const field = new FoodField({
          bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5, waterTop: 5 },
          groundHeight: () => 0,
          current: (x, y, z, out) => sampleCurrent(params, x, y, z, time, out),
        });
        field.drop(food, 1, 0, 0, 0.05);
        const dt = 1 / 30;
        const limit = slowestEaterCruise(food) * FEEDING.strikeSpeedFactor;
        const last = new Map(field.particles.map((p) => [p.id, [p.x, p.y, p.z]] as const));
        let fastest = 0;
        for (; time < 120; time += dt) {
          field.step(dt);
          for (const p of field.particles) {
            const from = last.get(p.id) ?? [p.x, p.y, p.z];
            if (p.ageS > dt) {
              const dx = p.x - (from[0] ?? 0);
              const dy = p.y - (from[1] ?? 0);
              const dz = p.z - (from[2] ?? 0);
              fastest = Math.max(fastest, Math.hypot(dx, Math.max(0, dy), dz) / dt);
            }
            last.set(p.id, [p.x, p.y, p.z]);
          }
        }
        if (food === 'nori') expect(fastest).toBe(0);
        else expect(fastest).toBeGreaterThan(0);
        expect(fastest).toBeLessThanOrEqual(limit);
      },
    );
  });
});
