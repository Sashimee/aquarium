import type { FoodType } from '@aquarium/shared';
import { BEHAVIOUR } from './behaviour.ts';
import { FEEDING, gutForHunger, isScavenger } from './feeding.ts';
import { FOOD_PARTICLES, FOOD_TYPES } from './food.ts';
import type { SimSpecies } from './species.ts';

export { isScavenger };

/** Every tunable of the clean-up crew model; sources are in BEHAVIOUR.md. */
export const CREW = {
  /** Width of the film strip a grazer clears as it moves: radula or oral disc, per body length. */
  swathBodyLengths: 0.1,
  /** Film cleared per second while grazing in place (rasping, picking), per body length squared. */
  inPlaceBodyLengths2PerS: 0.0025,
} as const;

/**
 * How a species takes algae: a walker picking biofilm off whatever it stands on (shrimp, snails),
 * a fish rasping glass or decor belly-down (otocinclus, plecos), a fish pecking turf off rock
 * (tangs), or not at all.
 */
export type AlgaeGrazer = 'surface' | 'glass' | 'rock' | 'none';

export function algaeGrazer(sp: SimSpecies): AlgaeGrazer {
  if (sp.walking !== null) return sp.walking.biofilmGrazer ? 'surface' : 'none';
  return sp.grazer;
}

/** Film area in m² per second a grazer of standard length `length` clears moving at `speed`. */
export function grazeAreaRate(length: number, speed: number): number {
  return CREW.inPlaceBodyLengths2PerS * length * length + CREW.swathBodyLengths * length * speed;
}

/** What one fish of a running world grazed and scavenged since the last `takeCrewTally`. */
export interface CrewTally {
  readonly fishId: string;
  /** Algae film cleared, m²: the area grazed times the cover the world was told (`setAlgae`). */
  readonly algaeM2: number;
  /** Feed portions it ate of food that had settled on a surface. */
  readonly settledPortions: number;
}

const mean = (lo: number, hi: number): number => (lo + hi) / 2;

/**
 * Below the smallest particle there is no settled food left to find, so a forager that also
 * grazes glass turns to the glass.
 */
const SETTLED_FOOD_MIN_PORTIONS = Math.min(...Object.values(FOOD_PARTICLES).map((p) => p.portion));

/**
 * A bottom forager that grazes glass (a bristlenose pleco) does so only while it is sated or no
 * food has settled.
 */
export function grazesWhenNoFood(sp: SimSpecies): boolean {
  return sp.walking === null && sp.gait === 'forage' && sp.grazer === 'glass';
}

/**
 * Film area in m² per hour one crew member clears at full algae cover, averaged over the
 * grazing and non-grazing bouts the realtime model plays, so the offline lifecycle and a live
 * tank agree. `length` defaults to the species' standard length; speeds scale with it.
 */
export function algaeAreaPerHour(sp: SimSpecies, length = sp.bodyLength): number {
  const scale = length / sp.bodyLength;
  switch (algaeGrazer(sp)) {
    case 'surface': {
      const walk = sp.walking?.walkSpeed ?? 0;
      const pick = mean(BEHAVIOUR.grazerPickMinS, BEHAVIOUR.grazerPickMaxS);
      const move = mean(BEHAVIOUR.grazerWalkMinS, BEHAVIOUR.grazerWalkMaxS);
      const walking = move / (pick + move);
      return (
        3600 *
        (CREW.inPlaceBodyLengths2PerS * length * length +
          CREW.swathBodyLengths * length * walking * walk * scale)
      );
    }
    case 'glass': {
      const stay = mean(BEHAVIOUR.glassStayMinS, BEHAVIOUR.glassStayMaxS);
      const roam = mean(BEHAVIOUR.glassRoamMinS, BEHAVIOUR.glassRoamMaxS);
      const crawl = BEHAVIOUR.glassCrawlFactor * sp.cruiseSpeed * scale;
      return 3600 * (stay / (stay + roam)) * grazeAreaRate(length, crawl);
    }
    case 'rock': {
      const bout = mean(sp.grazeMinS, sp.grazeMaxS);
      return 3600 * Math.min(1, bout / sp.grazeMeanIntervalS) * grazeAreaRate(length, 0);
    }
    case 'none':
      return 0;
  }
}

/** Where algae grows and food settles in a tank, from the water's inner box in metres. */
export interface CleanupSurfaces {
  /** Glass below the waterline and the substrate: what the lifecycle's algae cover spreads over. */
  readonly grazableM2: number;
  /** The substrate, where uneaten food ends up. */
  readonly floorM2: number;
}

export function cleanupSurfaces(water: {
  readonly width: number;
  readonly depth: number;
  readonly height: number;
}): CleanupSurfaces {
  const { width, depth, height } = water;
  for (const [key, v] of Object.entries({ width, depth, height })) {
    if (!Number.isFinite(v) || v <= 0) {
      throw new RangeError(`cleanupSurfaces: ${key} must be a positive number of metres, got ${v}`);
    }
  }
  const floorM2 = width * depth;
  return { grazableM2: floorM2 + 2 * (width + depth) * height, floorM2 };
}

/**
 * Floor area in m² per hour a scavenger sweeps for settled food: it smells food out to
 * `scavengerChemoRangeFactor` × its perception range on either side while it moves.
 */
export function scavengeSweepPerHour(sp: SimSpecies, length = sp.bodyLength): number {
  if (!isScavenger(sp)) return 0;
  const scale = length / sp.bodyLength;
  const width = 2 * FEEDING.scavengerChemoRangeFactor * sp.perceptionRange * scale;
  let speed: number;
  if (sp.walking !== null) {
    const pick = sp.walking.biofilmGrazer
      ? mean(BEHAVIOUR.grazerPickMinS, BEHAVIOUR.grazerPickMaxS)
      : mean(BEHAVIOUR.walkerPickMinS, BEHAVIOUR.walkerPickMaxS);
    const move = sp.walking.biofilmGrazer
      ? mean(BEHAVIOUR.grazerWalkMinS, BEHAVIOUR.grazerWalkMaxS)
      : mean(BEHAVIOUR.walkerWalkMinS, BEHAVIOUR.walkerWalkMaxS);
    speed = (move / (pick + move)) * sp.walking.walkSpeed * scale;
  } else {
    const sift = mean(BEHAVIOUR.siftMinS, BEHAVIOUR.siftMaxS);
    const move = mean(BEHAVIOUR.moveMinS, BEHAVIOUR.moveMaxS);
    speed = ((sift * BEHAVIOUR.siftSpeedFactor + move) / (sift + move)) * sp.cruiseSpeed * scale;
  }
  return 3600 * speed * width;
}

export interface CrewMember {
  readonly id: string;
  readonly species: string;
  /** A dead crew member grazes and scavenges nothing. */
  readonly alive: boolean;
  /** Standard length; the species' own when missing. */
  readonly bodyLengthM?: number;
  /** Lifecycle hunger, 0 fed to 1 starving; an empty gut when missing. */
  readonly hunger?: number;
}

export interface CleanupInput {
  readonly crew: readonly CrewMember[];
  readonly species: ReadonlyMap<string, SimSpecies>;
  /** Lifecycle algae cover, 0 to 1. */
  readonly algae: number;
  /** Lifecycle uneaten food on the substrate, in feed portions. */
  readonly uneatenFood: number;
  /**
   * Food types the uneaten food is made of. A crew member whose diet has none of them neither
   * looks for it nor leaves the glass for it, as in the realtime model; one that eats any of them
   * may find all of it, since the lifecycle keeps one total. Every type when missing.
   */
  readonly uneatenFoodTypes?: readonly FoodType[];
  readonly dtHours: number;
  /**
   * Share of the step the tank lamp is on, 0 to 1. Diurnal and crepuscular crew rest in the dark
   * and nocturnal crew while the lamp is on, neither grazing nor feeding, as in the realtime
   * model; pass 1 or 0 from the lifecycle's `lampIsOn`.
   */
  readonly litFraction: number;
  readonly surfaces: CleanupSurfaces;
}

export interface CrewShare {
  readonly id: string;
  /** Algae cover this member took off, in the lifecycle's 0 to 1 units. */
  readonly algae: number;
  /** Feed portions of settled food it ate. */
  readonly food: number;
}

export interface CleanupResult {
  /** Total algae cover the crew took off; never more than `algae`. */
  readonly algaeGrazed: number;
  /** Total feed portions eaten; never more than `uneatenFood` or what the crew had room for. */
  readonly foodEaten: number;
  /** One entry per living crew member that grazed or ate, in `crew` order. */
  readonly perFish: readonly CrewShare[];
}

function requireUnit(value: number, field: string): void {
  if (!(Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new RangeError(`crewCleanup: ${field} must be within 0 to 1, got ${value}`);
  }
}

function requireNonNegative(value: number, field: string): void {
  if (!(Number.isFinite(value) && value >= 0)) {
    throw new RangeError(`crewCleanup: ${field} must be a non-negative number, got ${value}`);
  }
}

/**
 * What the clean-up crew grazes and scavenges over the part of `dtHours` each member is awake
 * (`litFraction` of it, or the rest for nocturnal species) with the water otherwise held still;
 * the lifecycle adds algae growth and food decay around it. Algae is cleared as a sweep of the
 * grazable surfaces: each member clears its film area per hour, of which the share `algae` is
 * covered, so cover falls as dA/dt = −A·Σrate/area and never below zero. Settled food is found by
 * the floor area scavengers sweep (dF/dt = −F·Σsweep/floor) and eaten up to the room each gut has
 * once it has emptied over the step (`FEEDING.gastricEvacuationTauS`); a member whose diet has
 * none of `uneatenFoodTypes` does not look for it. A hungry forager that also grazes glass sweeps
 * for food it eats until less than the smallest particle is left and grazes for the rest of the
 * step; a sated one grazes all of it, as it does live. Pure and deterministic.
 */
export function crewCleanup(input: CleanupInput): CleanupResult {
  const { crew, species, algae, uneatenFood, dtHours, litFraction, surfaces } = input;
  const foodTypes = foodTypeIndices(input.uneatenFoodTypes);
  requireUnit(algae, 'algae');
  requireNonNegative(uneatenFood, 'uneatenFood');
  requireNonNegative(dtHours, 'dtHours');
  requireUnit(litFraction, 'litFraction');
  if (!(surfaces.grazableM2 > 0 && surfaces.floorM2 > 0)) {
    throw new RangeError('crewCleanup: surfaces need a positive grazable and floor area');
  }
  const graze: number[] = [];
  const sweep: number[] = [];
  const switches: boolean[] = [];
  const room: number[] = [];
  let sweepAll = 0;
  let sweepSteady = 0;
  let anySwitch = false;
  const emptied = Math.exp((-dtHours * 3600) / FEEDING.gastricEvacuationTauS);
  for (const member of crew) {
    const sp = species.get(member.species);
    if (sp === undefined) {
      throw new Error(
        `crewCleanup: crew member "${member.id}" has unknown species "${member.species}"`,
      );
    }
    const length = member.bodyLengthM ?? sp.bodyLength;
    if (!(Number.isFinite(length) && length > 0)) {
      throw new RangeError(`crewCleanup: crew member "${member.id}" needs a positive bodyLengthM`);
    }
    if (member.hunger !== undefined) requireUnit(member.hunger, `hunger of "${member.id}"`);
    const awake = sp.activity === 'nocturnal' ? 1 - litFraction : litFraction;
    const g = member.alive ? algaeAreaPerHour(sp, length) * awake : 0;
    const gut = member.hunger === undefined ? 0 : gutForHunger(member.hunger);
    const sated =
      FEEDING.satiationPortions - gut <= FEEDING.satiatedMotivation * FEEDING.satiationPortions;
    const eats = foodTypes.some((t) => (sp.foodPreference[t] ?? 0) > 0);
    const switcher = grazesWhenNoFood(sp) && g > 0;
    const switching = switcher && !sated && eats;
    const s =
      member.alive && eats && !(switcher && sated) ? scavengeSweepPerHour(sp, length) * awake : 0;
    graze.push(g);
    sweep.push(s);
    switches.push(switching);
    room.push(s > 0 ? Math.max(0, FEEDING.satiationPortions - gut * emptied) : 0);
    sweepAll += s;
    if (!switching) sweepSteady += s;
    anySwitch ||= switching;
  }
  const foodHours = settledFoodHours(uneatenFood, sweepAll, dtHours, surfaces.floorM2, anySwitch);
  const left = uneatenFood * Math.exp((-sweepAll * foodHours) / surfaces.floorM2);
  const foundAll = uneatenFood - left;
  const foundSteady = left * -Math.expm1((-sweepSteady * (dtHours - foodHours)) / surfaces.floorM2);
  const shares = sweep.map(
    (s, m) =>
      (sweepAll > 0 ? (s * foundAll) / sweepAll : 0) +
      (!switches[m] && sweepSteady > 0 ? (s * foundSteady) / sweepSteady : 0),
  );
  const grazed = graze.map((g, m) => g * (switches[m] ? dtHours - foodHours : dtHours));
  const grazeTotal = grazed.reduce((sum, g) => sum + g, 0);
  const algaeGrazed = algae * -Math.expm1(-grazeTotal / surfaces.grazableM2);
  // A full scavenger leaves its share for hungrier ones, as at a real food drop.
  const food = allocate(foundAll + foundSteady, shares, room);
  const perFish: CrewShare[] = [];
  let foodEaten = 0;
  crew.forEach((member, m) => {
    const a = grazeTotal > 0 ? (algaeGrazed * (grazed[m] ?? 0)) / grazeTotal : 0;
    const f = food[m] ?? 0;
    foodEaten += f;
    if (a > 0 || f > 0) perFish.push({ id: member.id, algae: a, food: f });
  });
  return { algaeGrazed, foodEaten, perFish };
}

function foodTypeIndices(types: readonly FoodType[] | undefined): number[] {
  if (types === undefined) return FOOD_TYPES.map((_, t) => t);
  return types.map((type) => {
    const t = FOOD_TYPES.indexOf(type);
    if (t < 0) {
      throw new RangeError(
        `crewCleanup: unknown food type "${String(type)}" in uneatenFoodTypes; known foods are ${FOOD_TYPES.join(', ')}`,
      );
    }
    return t;
  });
}

/**
 * Hours of the step during which at least the smallest particle of settled food is left, with
 * the whole crew sweeping for it; the whole step when no member turns from food to glass.
 */
function settledFoodHours(
  food: number,
  sweep: number,
  dtHours: number,
  floorM2: number,
  anySwitch: boolean,
): number {
  if (!anySwitch) return dtHours;
  if (food <= SETTLED_FOOD_MIN_PORTIONS) return 0;
  if (sweep <= 0) return dtHours;
  return Math.min(dtHours, (floorM2 * Math.log(food / SETTLED_FOOD_MIN_PORTIONS)) / sweep);
}

/**
 * Splits `amount` by `weight`, giving no one more than its `cap`; what a capped member leaves goes
 * to the rest by weight until the amount or every cap is used up.
 */
function allocate(amount: number, weight: readonly number[], cap: readonly number[]): number[] {
  const out = weight.map(() => 0);
  let left = amount;
  const open = new Set<number>();
  weight.forEach((w, m) => {
    if (w > 0 && (cap[m] ?? 0) > 0) open.add(m);
  });
  while (left > 1e-15 && open.size > 0) {
    let total = 0;
    for (const m of open) total += weight[m] ?? 0;
    let given = 0;
    for (const m of [...open]) {
      const want = (left * (weight[m] ?? 0)) / total;
      const space = (cap[m] ?? 0) - (out[m] ?? 0);
      const take = Math.min(want, space);
      out[m] = (out[m] ?? 0) + take;
      given += take;
      if (take >= space) open.delete(m);
    }
    left -= given;
  }
  return out;
}
