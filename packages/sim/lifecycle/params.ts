import type { TankSize, WaterParameters } from '@aquarium/shared';

export const STEP_MINUTES = 10;
export const STEP_MS = STEP_MINUTES * 60_000;
export const MAX_CATCH_UP_DAYS = 60;
export const MAX_CATCH_UP_MS = MAX_CATCH_UP_DAYS * 86_400_000;
export const GRACE_PERIOD_MS = 48 * 3_600_000;

export const VACATION_FEEDER_ASSET_ID = 'vacation-feeder';
export const VACATION_HUNGER_FACTOR = 0.5;

/** Fish below this health stop growing; above it, growth resumes. */
export const GROWTH_MIN_HEALTH = 0.7;
/** Hunger removed by one portion that a fish eats. */
export const HUNGER_PER_PORTION = 0.4;
/** Toxicity multiplier on health loss is capped so a single bad hour is never instant death. */
export const MAX_TOXICITY_FACTOR = 4;
/** A carcass left in the tank loads the water like a live fish of the same size. */
export const CARCASS_BIOLOAD_FACTOR = 1;

export const WATER_CHANGE_FRACTION = 0.5;

/** The tank the water and bioload constants are tuned for: the `standard` size. */
export const REFERENCE_TANK_LITRES = 300;
/**
 * Fish waste concentrates as (reference / litres)^exponent, not linearly: the nano stock cap is only 4x
 * tighter than standard for 10x less water, so 0.6 (4x at 30 L) makes a full nano as concentrated as a full
 * standard tank. Uneaten food is not scaled: a portion is a fixed player action, and species with an
 * ammonia tolerance of 0.09 already sit just under the limit from one portion at any size.
 */
export const VOLUME_CONCENTRATION_EXPONENT = 0.6;
export const TANK_BIOLOAD_CAPACITY = 12;
/** Not linear in litres: a 30 L nano holds 12 small animals (12 neon tetras are 2.4), which a linear 1.2 would forbid. */
export const BIOLOAD_CAPACITY_BY_SIZE: Readonly<Record<TankSize, number>> = {
  nano30: 3,
  standard: TANK_BIOLOAD_CAPACITY,
  std200: 8,
  long300: TANK_BIOLOAD_CAPACITY,
};
export const MAX_FISH_PER_TANK = 60;
export const MAX_UNEATEN_FOOD = 20;

export const DEFAULT_WATER_PARAMETERS: WaterParameters = {
  foodDecayMinutes: 180,
  ammoniaPerPortion: 0.15,
  algaePerHour: 0.002,
};

export const FEEDING_WINDOW_MINUTES = 120;
export const MAX_PORTIONS_PER_FISH_PER_WINDOW = 2;
export const FUTURE_SKEW_MS = 60_000;

export const BREEDING_CHANCE_PER_STEP = STEP_MS / 86_400_000;
export const BREEDING_DEFAULT_MIN_HEALTH = 0.8;
export const BREEDING_DEFAULT_MAX_HUNGER = 0.5;
/** Fry and juveniles together may fill at most this share of a tank's animal cap. */
export const MAX_YOUNG_FRACTION = 0.5;
/** Decor that counts as a spawning cave or shelter for species with `needsCave`. */
export const BREEDING_SHELTER_ASSET_IDS: readonly string[] = [
  'reef-arch',
  'lambis-shell',
  'boulder-01',
  'coast-rocks-05',
  'dead-quiver-trunk',
  'dead-tree-trunk-02',
  'driftwood-branch',
];
