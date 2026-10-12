import type { CauseOfDeath, SpeciesLifecycle } from '@aquarium/shared';
import {
  CARCASS_BIOLOAD_FACTOR,
  GROWTH_MIN_HEALTH,
  MAX_TOXICITY_FACTOR,
  VACATION_HUNGER_FACTOR,
} from './params.ts';
import type { LifecycleFish } from './types.ts';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const DAY_MS = 86_400_000;

export interface FishStepInput {
  readonly nowMs: number;
  readonly dtHours: number;
  readonly ammonia: number;
  readonly vacationFeeder: boolean;
  readonly grace: boolean;
}

export function toxicityFactor(ammonia: number, tolerance: number): number {
  if (ammonia <= tolerance) return 0;
  return tolerance > 0 ? Math.min(ammonia / tolerance, MAX_TOXICITY_FACTOR) : MAX_TOXICITY_FACTOR;
}

export function stepFish(
  fish: LifecycleFish,
  spec: SpeciesLifecycle,
  input: FishStepInput,
): LifecycleFish {
  if (!fish.alive) return fish;
  const { dtHours, nowMs } = input;

  const hungerRate = spec.hungerPerHour * (input.vacationFeeder ? VACATION_HUNGER_FACTOR : 1);
  const hunger = clamp01(fish.hunger + hungerRate * dtHours);

  const starving = hunger > spec.starvationHungerThreshold;
  const toxicity = toxicityFactor(input.ammonia, spec.ammoniaTolerance);
  const starveLoss = starving ? spec.healthLossPerHourStarving * dtHours : 0;
  const toxicLoss = spec.healthLossPerHourStarving * toxicity * dtHours;
  const harmed = starving || toxicity > 0;

  const loss = input.grace ? 0 : starveLoss + toxicLoss;
  const gain = harmed ? 0 : spec.healthRecoveryPerHour * dtHours;
  const health = clamp01(fish.health - loss + gain);

  const size =
    !harmed && health >= GROWTH_MIN_HEALTH
      ? Math.min(spec.maxSizeM, fish.size + (spec.growthPerDay * dtHours) / 24)
      : fish.size;

  let cause: CauseOfDeath | null = null;
  if (nowMs - fish.bornAtMs >= spec.lifespanDays * DAY_MS) cause = 'old_age';
  else if (health <= 0) cause = toxicLoss > starveLoss ? 'ammonia' : 'starvation';

  if (cause) {
    return { ...fish, hunger, health, size, alive: false, diedAtMs: nowMs, cause };
  }
  return { ...fish, hunger, health, size };
}

export function fishBioload(fish: LifecycleFish, spec: SpeciesLifecycle): number {
  const sizeRatio = Math.min(1, fish.size / spec.maxSizeM);
  return spec.bioload * sizeRatio * (fish.alive ? 1 : CARCASS_BIOLOAD_FACTOR);
}
