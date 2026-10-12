import type { Water } from '@aquarium/shared';
import { fishBioload } from './fish.ts';
import type { LifecycleFish, SpeciesTable, StepContext } from './types.ts';

export function ammoniaProduction(
  fish: readonly LifecycleFish[],
  species: SpeciesTable,
): { bioload: number; perHour: number } {
  let bioload = 0;
  let perHour = 0;
  for (const f of fish) {
    const spec = species.get(f.species);
    if (!spec) throw new Error(`lifecycle: unknown species "${f.species}"`);
    const load = fishBioload(f, spec);
    bioload += load;
    perHour += load * spec.ammoniaPerBioloadPerHour;
  }
  return { bioload, perHour };
}

export function stepWater(water: Water, fish: readonly LifecycleFish[], ctx: StepContext): Water {
  const { dtHours, params } = ctx;
  const { bioload, perHour } = ammoniaProduction(fish, ctx.species);

  const decayed = water.uneatenFood * (1 - Math.exp((-dtHours * 60) / params.foodDecayMinutes));
  const withFood = water.ammonia + decayed * params.ammoniaPerPortion;

  // Closed-form solution of dA/dt = P - k·A, so a long step can never overshoot the equilibrium.
  const k = params.filterRemovalPerHour;
  const ammonia =
    k > 0
      ? perHour / k + (withFood - perHour / k) * Math.exp(-k * dtHours)
      : withFood + perHour * dtHours;

  return {
    ammonia: Math.max(0, ammonia),
    nitrate: water.nitrate + params.nitratePerHour * bioload * dtHours,
    algae: Math.min(1, water.algae + params.algaePerHour * dtHours),
    uneatenFood: Math.max(0, water.uneatenFood - decayed),
  };
}
