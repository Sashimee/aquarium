import {
  usableEquipment,
  type Bacteria,
  type Biome,
  type Chemistry,
  type ChemistryParameters,
  type Equipment,
  type Water,
} from '@aquarium/shared';
import { fishBioload } from './fish.ts';
import {
  FOOD_CONCENTRATION_EXPONENT,
  REFERENCE_TANK_LITRES,
  VOLUME_CONCENTRATION_EXPONENT,
} from './params.ts';
import type { LifecycleFish, SpeciesChemistryTable, SpeciesTable, StepContext } from './types.ts';

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

/**
 * A thermostat heater holds the temperature that costs the stocked fish the least comfort. With no fish,
 * or when the biome target already suits them, that is the biome target; otherwise the middle of the
 * temperatures where the stocked fish are least stressed, so a discus tank warms to its own range.
 */
export function heaterSetpoint(
  fish: readonly LifecycleFish[],
  biome: Biome,
  speciesChemistry: SpeciesChemistryTable,
  params: ChemistryParameters,
): number {
  const target = params.temperature.target[biome];
  const stocked = new Map<string, number>();
  for (const f of fish) if (f.alive) stocked.set(f.species, (stocked.get(f.species) ?? 0) + 1);
  const ranges: { range: readonly [number, number]; count: number }[] = [];
  for (const [id, count] of stocked) {
    const range = speciesChemistry.get(id)?.temperatureC;
    if (range) ranges.push({ range, count });
  }
  if (ranges.length === 0) return target;
  const discomfort = (t: number): number =>
    ranges.reduce(
      (sum, { range: [lo, hi], count }) => sum + count * Math.max(lo - t, t - hi, 0),
      0,
    );
  const candidates = [target, ...ranges.flatMap(({ range: [lo, hi] }) => [lo, hi])];
  const best = Math.min(...candidates.map(discomfort));
  const optimal = candidates.filter((t) => discomfort(t) <= best + 1e-9);
  const low = Math.min(...optimal);
  const high = Math.max(...optimal);
  return target >= low && target <= high ? target : (low + high) / 2;
}

function atTier(values: readonly number[], tier: number): number {
  const value = values[tier];
  if (value === undefined) throw new Error(`lifecycle: no equipment value for tier ${tier}`);
  return value;
}

export function lampIsOn(nowMs: number, dtHours: number, onHour: number, offHour: number): boolean {
  const midMs = nowMs - (dtHours * 3_600_000) / 2;
  const hour = Math.floor((((midMs % 86_400_000) + 86_400_000) % 86_400_000) / 3_600_000);
  return onHour < offHour ? hour >= onHour && hour < offHour : hour >= onHour || hour < offHour;
}

export function algaeMultiplier(
  equipment: Equipment,
  cp: ChemistryParameters,
  nowMs: number,
  dtHours: number,
): number {
  const { light, co2, waveMaker } = equipment;
  const lit = lampIsOn(nowMs, dtHours, light.onHour, light.offHour);
  const growth = lit
    ? atTier(cp.equipment.light.algaeGrowthPerTier, light.tier) * light.intensity
    : 0;
  return (
    growth *
    atTier(cp.equipment.co2.algaeFactorPerTier, co2.tier) *
    atTier(cp.equipment.waveMaker.algaeFactorPerTier, waveMaker.tier)
  );
}

export function stepWater(
  state: { water: Water; chemistry: Chemistry },
  fish: readonly LifecycleFish[],
  ctx: StepContext,
): { water: Water; chemistry: Chemistry } {
  const { water, chemistry } = state;
  const { dtHours, params, chemistryParams: cp } = ctx;
  const equipment = usableEquipment(ctx.biome, ctx.equipment);
  const { bioload, perHour: massPerHour } = ammoniaProduction(fish, ctx.species);
  const dilution = REFERENCE_TANK_LITRES / ctx.litres;
  const concentration = dilution ** VOLUME_CONCENTRATION_EXPONENT;
  const withinCapacity = bioload > ctx.bioloadCapacity ? ctx.bioloadCapacity / bioload : 1;
  const perHour = massPerHour * Math.max(1, concentration * withinCapacity);

  const decayed = water.uneatenFood * (1 - Math.exp((-dtHours * 60) / params.foodDecayMinutes));
  const withFood =
    water.ammonia + decayed * params.ammoniaPerPortion * dilution ** FOOD_CONCENTRATION_EXPONENT;

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
      water.ammonia + perHour * dtHours > cp.bacteria.minSubstrate,
      cp.bacteria.ammoniaOxidisers,
      cp.bacteria,
      dtHours,
    ),
    nitriteOxidisers: stepColony(
      no2Bugs,
      capacity,
      chemistry.nitrite + toNitrite > cp.bacteria.minSubstrate,
      cp.bacteria.nitriteOxidisers,
      cp.bacteria,
      dtHours,
    ),
  };

  const nitrate = water.nitrate + nitrateMade;
  const kh = Math.max(0, chemistry.kh - cp.kh.consumedPerNitrate * nitrateMade);
  const phTarget =
    cp.ph.target[ctx.biome] -
    atTier(cp.equipment.co2.phDropPerTier, equipment.co2.tier) -
    (cp.ph.acidificationPerNitrate * nitrate) / Math.max(kh, cp.ph.minBufferKh) -
    cp.tannin.phDropAtFull * water.tannin;

  const heater = ctx.equipment.heater.tier;
  const heatedTo = Math.min(
    ctx.heaterSetpointC,
    cp.temperature.roomC +
      (cp.temperature.heaterWarmingPerHourPerTier * heater) / cp.temperature.driftPerHour,
  );

  const temperatureGoal = heater > 0 ? heatedTo : cp.temperature.roomC;
  const warmingUp = chemistry.temperatureC < temperatureGoal;
  const temperatureRate = warmingUp
    ? Math.max(cp.temperature.driftPerHour, cp.temperature.heaterWarmupRatePerHourPerTier * heater)
    : cp.temperature.driftPerHour;

  return {
    water: {
      ...water,
      ammonia,
      nitrate,
      algae: Math.min(
        1,
        water.algae +
          params.algaePerHour * algaeMultiplier(equipment, cp, ctx.nowMs, dtHours) * dtHours,
      ),
      uneatenFood: Math.max(0, water.uneatenFood - decayed),
      tannin: water.tannin * Math.exp(-cp.tannin.decayPerHour * dtHours),
    },
    chemistry: {
      nitrite,
      ph: Math.min(14, Math.max(0, towards(chemistry.ph, phTarget, cp.ph.driftPerHour, dtHours))),
      kh,
      temperatureC: towards(chemistry.temperatureC, temperatureGoal, temperatureRate, dtHours),
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
