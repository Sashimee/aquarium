import type {
  CauseOfDeath,
  Chemistry,
  ChemistryParameters,
  SpeciesChemistry,
  SpeciesLifecycle,
} from '@aquarium/shared';
import {
  CARCASS_BIOLOAD_FACTOR,
  GROWTH_MIN_HEALTH,
  MAX_TOXICITY_FACTOR,
  VACATION_HUNGER_FACTOR,
} from './params.ts';
import { DISEASE_IMMUNE_SPECIES, isNewFish, stepDisease, type KindRates } from './disease.ts';
import type { ActiveMedicine, LifecycleFish } from './types.ts';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const DAY_MS = 86_400_000;
/** A fish this ill stops healing and growing, as it does when starving or poisoned. */
const SICK_HALTS_RECOVERY = 0.3;

export interface FishStepInput {
  readonly nowMs: number;
  readonly dtHours: number;
  readonly ammonia: number;
  readonly chemistry: Chemistry;
  readonly chemistryParams: ChemistryParameters;
  readonly vacationFeeder: boolean;
  readonly grace: boolean;
  readonly medicine: ActiveMedicine | null;
  /** Severities of the sick tank-mates by kind, from `contagionFrom`. */
  readonly contagion: KindRates;
}

export function toxicityFactor(ammonia: number, tolerance: number): number {
  if (ammonia <= tolerance) return 0;
  return tolerance > 0 ? Math.min(ammonia / tolerance, MAX_TOXICITY_FACTOR) : MAX_TOXICITY_FACTOR;
}

/** How far ammonia is above the tolerance, in tolerances: continuous from 0, unlike `toxicityFactor`, which jumps to 1. */
function ammoniaExcess(ammonia: number, tolerance: number): number {
  if (ammonia <= tolerance) return 0;
  return tolerance > 0
    ? Math.min(ammonia / tolerance - 1, MAX_TOXICITY_FACTOR)
    : MAX_TOXICITY_FACTOR;
}

export function nitriteFactor(nitrite: number, tolerance: number, perUnit: number): number {
  return Math.min(Math.max(0, nitrite - tolerance) * perUnit, MAX_TOXICITY_FACTOR);
}

const outside = (value: number, [lo, hi]: readonly [number, number]): number =>
  Math.max(lo - value, value - hi, 0);

/** Sum of how far pH, temperature, salinity and hardness sit outside the species' comfort, in units of full stress. */
export function stressParts(
  chemistry: Chemistry,
  spec: SpeciesChemistry,
  params: ChemistryParameters,
): { temperature: number; other: number } {
  const full = params.stress.fullStressDeviation;
  return {
    temperature: outside(chemistry.temperatureC, spec.temperatureC) / full.temperatureC,
    other:
      outside(chemistry.ph, spec.phRange) / full.ph +
      outside(chemistry.salinity, spec.salinityPpt) / full.salinity +
      Math.max(0, spec.khMin - chemistry.kh) / full.kh,
  };
}

export function waterStress(
  chemistry: Chemistry,
  spec: SpeciesChemistry,
  params: ChemistryParameters,
): number {
  const parts = stressParts(chemistry, spec, params);
  return Math.min(parts.temperature + parts.other, MAX_TOXICITY_FACTOR);
}

export function stepFish(
  fish: LifecycleFish,
  spec: SpeciesLifecycle,
  chemSpec: SpeciesChemistry,
  input: FishStepInput,
): LifecycleFish {
  if (!fish.alive) return fish;
  const { dtHours, nowMs, chemistryParams } = input;

  const hungerRate = spec.hungerPerHour * (input.vacationFeeder ? VACATION_HUNGER_FACTOR : 1);
  const hunger = clamp01(fish.hunger + hungerRate * dtHours);

  const starving = hunger > spec.starvationHungerThreshold;
  const unit = spec.healthLossPerHourStarving * dtHours;
  const starveLoss = starving ? unit : 0;
  const ammoniaLoss = unit * toxicityFactor(input.ammonia, spec.ammoniaTolerance);
  const nitriteLoss =
    unit *
    nitriteFactor(
      input.chemistry.nitrite,
      chemSpec.nitriteTolerance,
      chemistryParams.nitrite.toxicityPerUnit,
    );
  const stress = waterStress(input.chemistry, chemSpec, chemistryParams);
  const stressLoss = unit * chemistryParams.stress.healthLossFraction * stress;
  const parts = stressParts(input.chemistry, chemSpec, chemistryParams);
  const sickness = DISEASE_IMMUNE_SPECIES.has(fish.species)
    ? { disease: null, lossUnits: 0, overdoseUnits: 0 }
    : stepDisease(fish, {
        nowMs,
        dtHours,
        grace: input.grace,
        medicine: input.medicine,
        stress,
        pressure: {
          temperatureStress: parts.temperature,
          pollution:
            ammoniaExcess(input.ammonia, spec.ammoniaTolerance) +
            nitriteFactor(
              input.chemistry.nitrite,
              chemSpec.nitriteTolerance,
              chemistryParams.nitrite.toxicityPerUnit,
            ),
          chemistryStress: parts.other,
          newFish: isNewFish(fish, nowMs),
          contagion: input.contagion,
          health: fish.health,
        },
      });
  const diseaseLoss = unit * sickness.lossUnits;
  const overdoseLoss = unit * sickness.overdoseUnits;
  const sick = sickness.disease !== null && sickness.disease.severity >= SICK_HALTS_RECOVERY;
  const harmed = starving || ammoniaLoss + nitriteLoss > 0 || sick;

  const loss = input.grace
    ? 0
    : starveLoss + ammoniaLoss + nitriteLoss + stressLoss + diseaseLoss + overdoseLoss;
  const gain = harmed ? 0 : spec.healthRecoveryPerHour * dtHours * (1 - Math.min(1, stress));
  const health = clamp01(fish.health - loss + gain);

  const size =
    !harmed && health >= GROWTH_MIN_HEALTH
      ? Math.min(spec.maxSizeM, fish.size + (spec.growthPerDay * dtHours) / 24)
      : fish.size;

  let cause: CauseOfDeath | null = null;
  if (nowMs - fish.bornAtMs >= spec.lifespanDays * DAY_MS) cause = 'old_age';
  else if (health <= 0) {
    cause = dominantCause(
      starveLoss,
      ammoniaLoss,
      nitriteLoss,
      stressLoss + overdoseLoss,
      diseaseLoss,
    );
  }

  const { disease } = sickness;
  if (cause) {
    return { ...fish, hunger, health, size, disease, alive: false, diedAtMs: nowMs, cause };
  }
  return { ...fish, hunger, health, size, disease };
}

function dominantCause(
  starve: number,
  ammonia: number,
  nitrite: number,
  stress: number,
  disease: number,
): CauseOfDeath {
  const worst = Math.max(starve, ammonia, nitrite, stress, disease);
  if (worst === starve) return 'starvation';
  if (worst === ammonia) return 'ammonia';
  if (worst === nitrite) return 'nitrite';
  if (worst === disease && disease > 0) return 'disease';
  return worst > 0 ? 'water_quality' : 'unknown';
}

export function fishBioload(fish: LifecycleFish, spec: SpeciesLifecycle): number {
  const sizeRatio = Math.min(1, fish.size / spec.maxSizeM);
  return spec.bioload * sizeRatio * (fish.alive ? 1 : CARCASS_BIOLOAD_FACTOR);
}
