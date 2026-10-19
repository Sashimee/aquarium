import type { Bacteria, Chemistry, Water } from '@aquarium/shared';
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

/** Closed-form solution of dX/dt = inflow - k·X, so a long step can never overshoot the equilibrium. */
function relax(x: number, inflowPerHour: number, k: number, dtHours: number): number {
  if (k <= 0) return x + inflowPerHour * dtHours;
  const equilibrium = inflowPerHour / k;
  return Math.max(0, equilibrium + (x - equilibrium) * Math.exp(-k * dtHours));
}

const towards = (value: number, target: number, ratePerHour: number, dtHours: number): number =>
  target + (value - target) * Math.exp(-ratePerHour * dtHours);

export function colonyCapacity(filterTier: number, mediaCapacityPerFilterTier: number): number {
  return Math.min(1, filterTier * mediaCapacityPerFilterTier);
}

function stepColony(
  size: number,
  capacity: number,
  fed: boolean,
  rates: { growthPerHour: number; dieOffPerHour: number },
  bacteria: { ambientSeed: number; overCapacityDieOffPerHour: number },
  dtHours: number,
): number {
  if (size > capacity) {
    return capacity + (size - capacity) * Math.exp(-bacteria.overCapacityDieOffPerHour * dtHours);
  }
  if (!fed || capacity <= 0) return size * Math.exp(-rates.dieOffPerHour * dtHours);
  const grown =
    size + rates.growthPerHour * (size + bacteria.ambientSeed) * (1 - size / capacity) * dtHours;
  return Math.min(capacity, grown);
}

export function stepWater(
  state: { water: Water; chemistry: Chemistry },
  fish: readonly LifecycleFish[],
  ctx: StepContext,
): { water: Water; chemistry: Chemistry } {
  const { water, chemistry } = state;
  const { dtHours, params, chemistryParams: cp } = ctx;
  const { perHour } = ammoniaProduction(fish, ctx.species);

  const decayed = water.uneatenFood * (1 - Math.exp((-dtHours * 60) / params.foodDecayMinutes));
  const withFood = water.ammonia + decayed * params.ammoniaPerPortion;

  const { ammoniaOxidisers: nh3Bugs, nitriteOxidisers: no2Bugs } = chemistry.bacteria;
  const nh3Rate = cp.bacteria.ammoniaOxidisers.conversionPerHour * nh3Bugs;
  const ammonia = relax(withFood, perHour, nh3Rate, dtHours);
  const toNitrite = Math.max(0, withFood + perHour * dtHours - ammonia);

  const no2Rate = cp.bacteria.nitriteOxidisers.conversionPerHour * no2Bugs;
  const nitrite = relax(chemistry.nitrite, toNitrite / dtHours, no2Rate, dtHours);
  const toNitrate = Math.max(0, chemistry.nitrite + toNitrite - nitrite);
  const nitrateMade = toNitrate * cp.nitrate.yieldPerNitrite;

  const capacity = colonyCapacity(
    ctx.equipment.filter.tier,
    cp.bacteria.mediaCapacityPerFilterTier,
  );
  const bacteria: Bacteria = {
    ammoniaOxidisers: stepColony(
      nh3Bugs,
      capacity,
      water.ammonia + perHour > cp.bacteria.minSubstrate,
      cp.bacteria.ammoniaOxidisers,
      cp.bacteria,
      dtHours,
    ),
    nitriteOxidisers: stepColony(
      no2Bugs,
      capacity,
      chemistry.nitrite + toNitrite / dtHours > cp.bacteria.minSubstrate,
      cp.bacteria.nitriteOxidisers,
      cp.bacteria,
      dtHours,
    ),
  };

  const nitrate = water.nitrate + nitrateMade;
  const kh = Math.max(0, chemistry.kh - cp.kh.consumedPerNitrate * nitrateMade);
  const phTarget =
    cp.ph.target[ctx.biome] -
    (cp.ph.acidificationPerNitrate * nitrate) / Math.max(kh, cp.ph.minBufferKh);

  const heater = ctx.equipment.heater.tier;
  const heatedTo = Math.min(
    cp.temperature.target[ctx.biome],
    cp.temperature.roomC +
      (cp.temperature.heaterWarmingPerHourPerTier * heater) / cp.temperature.driftPerHour,
  );

  return {
    water: {
      ammonia,
      nitrate,
      algae: Math.min(1, water.algae + params.algaePerHour * dtHours),
      uneatenFood: Math.max(0, water.uneatenFood - decayed),
    },
    chemistry: {
      nitrite,
      ph: Math.min(14, Math.max(0, towards(chemistry.ph, phTarget, cp.ph.driftPerHour, dtHours))),
      kh,
      temperatureC: towards(
        chemistry.temperatureC,
        heater > 0 ? heatedTo : cp.temperature.roomC,
        cp.temperature.driftPerHour,
        dtHours,
      ),
      salinity: towards(
        chemistry.salinity,
        cp.salinity.target[ctx.biome],
        cp.salinity.driftPerHour,
        dtHours,
      ),
      bacteria,
    },
  };
}
