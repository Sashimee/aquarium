import type { WaterParameters } from '@aquarium/shared';

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

export const TANK_BIOLOAD_CAPACITY = 12;
export const MAX_FISH_PER_TANK = 60;
export const MAX_UNEATEN_FOOD = 20;

export const DEFAULT_WATER_PARAMETERS: WaterParameters = {
  filterRemovalPerHour: 0.2,
  foodDecayMinutes: 180,
  nitratePerHour: 0.02,
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
