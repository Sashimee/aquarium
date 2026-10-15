import { traitSchema, type Species } from '@aquarium/shared';
import { BEHAVIOUR } from './behaviour.ts';
import { FOOD_TYPES } from './food.ts';
import { DEG } from './math.ts';

export type SpeciesInput = Pick<Species, 'id' | 'behaviour' | 'locomotion'> & {
  readonly lifecycle: Pick<Species['lifecycle'], 'diet'>;
};

/**
 * `lifecycle.diet` is read most-preferred first: each later entry is worth this fraction of the
 * one before it. Food missing from the diet is not eaten.
 */
export const DIET_RANK_DECAY = 0.7;

export const WATER_DENSITY = 1000;

/**
 * Drag F = ½·ρ·C·L²·v², referenced to body length squared. C ≈ laminar skin friction at
 * Re 10⁴–10⁵ (Blasius Cf ≈ 1.33·Re^-½ ≈ 0.005–0.013) × wetted area ≈ 0.4·L² × ~3 for the
 * swimming-induced boundary-layer thinning (Lighthill 1971; Anderson et al. 2001).
 */
export const DRAG_COEFFICIENT_L2 = 0.02;

/**
 * Species-specific behaviours the shared schema has no field for, named in `behaviour.traits`.
 * See BEHAVIOUR.md for what each one switches on.
 */
export const TRAITS = traitSchema.options;
export type Trait = (typeof TRAITS)[number];

/** Where a fish returns to: a scene anchor, a self-chosen mid-water station, or nowhere. */
export type HomeKind = 'anemone' | 'cave' | 'station' | 'none';
export type Gait = SpeciesInput['locomotion']['gait'];

/**
 * A walking invertebrate's locomotion. Walking is capped at `walkSpeed`, which may not exceed the
 * species' swimming cruise speed; the tail-flip is a half-sine speed pulse whose mean is
 * `flipSpeed` and whose peak, π/2 of that, may not exceed `maxSpeedMps`.
 */
export interface SimWalking {
  readonly walkSpeed: number;
  readonly strideBodyLengths: number;
  readonly legPairs: number;
  readonly substrate: boolean;
  readonly decor: boolean;
  readonly glass: boolean;
  readonly flipSpeed: number;
  readonly flipPeak: number;
  readonly flipDurationS: number;
  readonly flipRefractoryS: number;
  /** Picks biofilm off any surface it stands on, food or not. */
  readonly biofilmGrazer: boolean;
}

/** Peak over mean speed of a half-sine pulse. */
export const FLIP_PEAK_OVER_MEAN = Math.PI / 2;

/** Swimmer-only traits: none of their branches in `Behaviour.plan` runs for a walker. */
const SWIMMER_TRAITS: readonly Trait[] = [
  'shoal',
  'air-gulp',
  'glass-grazer',
  'rock-grazer',
  'anemone-host',
  'flare-display',
];
const WALKER_TRAITS: readonly Trait[] = ['biofilm-grazer', 'cleaner'];

export interface SimSpecies {
  readonly id: string;
  readonly gait: Gait;
  readonly bodyLength: number;
  readonly mass: number;
  readonly maxSpeed: number;
  readonly cruiseSpeed: number;
  readonly maxTurnRate: number;
  readonly maxPitch: number;
  readonly depthLow: number;
  readonly depthHigh: number;
  readonly perceptionRange: number;
  readonly perceptionFov: number;
  readonly neighbours: number;
  readonly schooling: boolean;
  /** Loose shoal (polarisation low) rather than a polarised school (Pitcher 1983). */
  readonly shoal: boolean;
  readonly tightenWhenStartled: boolean;
  readonly territorial: boolean;
  readonly boldness: number;
  readonly curiosity: number;
  readonly home: HomeKind;
  readonly airGulp: boolean;
  readonly grazer: 'glass' | 'rock' | 'none';
  readonly flare: boolean;
  /** Turns its belly towards the nearest surface when close to it (cave ceilings, glass). */
  readonly bellyToSurface: boolean;
  /** Preference weight per `FOOD_TYPES` index, 1 for the first diet entry and 0 off the diet. */
  readonly foodPreference: readonly number[];
  readonly gulpsPerHour: number;
  readonly grazeMeanIntervalS: number;
  readonly grazeMinS: number;
  readonly grazeMaxS: number;
  readonly flareMinS: number;
  readonly flareMaxS: number;
  readonly stationRadiusBodyLengths: number;
  readonly restationMinS: number;
  readonly restationMaxS: number;
  readonly shelterAfterStartleS: number;
  readonly excursionMeanIntervalS: number;
  readonly hostLeashBodyLengths: number;
  /** Set for a walking invertebrate, which `walk.ts` moves instead of the swimming model. */
  readonly walking: SimWalking | null;
}

type TraitParams = Pick<
  SimSpecies,
  | 'gulpsPerHour'
  | 'grazeMeanIntervalS'
  | 'grazeMinS'
  | 'grazeMaxS'
  | 'flareMinS'
  | 'flareMaxS'
  | 'stationRadiusBodyLengths'
  | 'restationMinS'
  | 'restationMaxS'
  | 'shelterAfterStartleS'
  | 'excursionMeanIntervalS'
  | 'hostLeashBodyLengths'
>;

function parseTraits(id: string, traits: readonly string[]): ReadonlySet<Trait> {
  const known = new Set<string>(TRAITS);
  const out = new Set<Trait>();
  for (const t of traits) {
    if (!known.has(t)) {
      throw new RangeError(
        `species "${id}": unknown behaviour trait "${t}"; known traits are ${TRAITS.join(', ')}`,
      );
    }
    out.add(t as Trait);
  }
  const conflicts: [Trait, Trait][] = [
    ['anemone-host', 'cave-dweller'],
    ['glass-grazer', 'rock-grazer'],
  ];
  for (const [a, b] of conflicts) {
    if (out.has(a) && out.has(b)) {
      throw new RangeError(`species "${id}": traits "${a}" and "${b}" exclude each other`);
    }
  }
  return out;
}

/**
 * Rejects a trait whose behaviour `Behaviour.planDefault` never reaches on this gait, so that it
 * cannot be ignored silently. The branch order there is: forage gait, then glass grazing, then a
 * home (anchor or station), then free swimming. A `cave-dweller` is not listed: every gait
 * shelters in its cave at rest and after a startle.
 */
function requireReachable(id: string, traits: ReadonlySet<Trait>, gait: Gait): void {
  const forager = gait === 'forage';
  const rules: [Trait, boolean, string][] = [
    ['air-gulp', forager, 'gait "forage", the only gait that starts a gulp'],
    ['glass-grazer', !forager, 'a gait other than "forage", whose bottom foraging comes first'],
    [
      'anemone-host',
      !forager && !traits.has('glass-grazer'),
      'a gait other than "forage" and no "glass-grazer", which both come before hosting',
    ],
    [
      'rock-grazer',
      !forager && gait !== 'hover' && !traits.has('anemone-host') && !traits.has('cave-dweller'),
      'a gait other than "hover" or "forage" and no anemone or cave home, to swim free',
    ],
  ];
  for (const [trait, reachable, needs] of rules) {
    if (traits.has(trait) && !reachable) {
      throw new RangeError(`species "${id}": trait "${trait}" needs ${needs}`);
    }
  }
}

function parseDiet(id: string, diet: unknown): number[] {
  if (!Array.isArray(diet) || diet.length === 0) {
    throw new RangeError(`species "${id}": lifecycle.diet must be a non-empty array of food types`);
  }
  const weights = FOOD_TYPES.map(() => 0);
  diet.forEach((food: unknown, rank) => {
    const k = FOOD_TYPES.findIndex((t) => t === food);
    if (k < 0) {
      throw new RangeError(
        `species "${id}": unknown food "${String(food)}" in lifecycle.diet; known foods are ${FOOD_TYPES.join(', ')}`,
      );
    }
    if (weights[k] !== 0)
      throw new RangeError(`species "${id}": "${String(food)}" repeats in lifecycle.diet`);
    weights[k] = DIET_RANK_DECAY ** rank;
  });
  return weights;
}

function requirePositive(value: number, field: string, id: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`species "${id}": ${field} must be a positive number, got ${value}`);
  }
  return value;
}

function requireOrdered(min: number, max: number, field: string, id: string): void {
  if (min > max) {
    throw new RangeError(
      `species "${id}": behaviour.${field} min ${min} exceeds max ${max} after filling in defaults`,
    );
  }
}

/**
 * Reads the optional per-trait parameter objects over the `BEHAVIOUR` defaults. An object the
 * sim would never read fails loading like an unknown trait does, rather than being ignored.
 * Which objects are read follows the branch order of `Behaviour.planDefault`: forage gait, then
 * glass grazing, then a home (anchor or station), then free swimming.
 */
function parseTraitParams(
  id: string,
  behaviour: SpeciesInput['behaviour'],
  traits: ReadonlySet<Trait>,
  gait: Gait,
  home: HomeKind,
  walker: boolean,
): TraitParams {
  const { airGulp, grazing, flare, station, refuge, excursion } = behaviour;
  const homed = !walker && gait !== 'forage' && !traits.has('glass-grazer') && home !== 'none';
  const owners: [string, unknown, boolean, string][] = [
    ['airGulp', airGulp, traits.has('air-gulp'), 'trait "air-gulp"'],
    ['grazing', grazing, traits.has('rock-grazer'), 'trait "rock-grazer"'],
    ['flare', flare, traits.has('flare-display'), 'trait "flare-display"'],
    [
      'station',
      station,
      homed,
      walker
        ? 'a swimmer: walkers hold no station'
        : 'gait "hover" or an anemone or cave home, without gait "forage" or trait "glass-grazer"',
    ],
    ['refuge', refuge, traits.has('cave-dweller'), 'trait "cave-dweller"'],
    ['excursion', excursion, traits.has('anemone-host'), 'trait "anemone-host"'],
  ];
  for (const [field, value, active, needs] of owners) {
    if (value !== undefined && !active) {
      throw new RangeError(`species "${id}": behaviour.${field} is set but needs ${needs}`);
    }
  }
  const params: TraitParams = {
    gulpsPerHour: requirePositive(
      airGulp?.perHour ?? BEHAVIOUR.gulpsPerHour,
      'behaviour.airGulp.perHour',
      id,
    ),
    grazeMeanIntervalS: requirePositive(
      grazing?.meanIntervalS ?? BEHAVIOUR.grazeMeanIntervalS,
      'behaviour.grazing.meanIntervalS',
      id,
    ),
    grazeMinS: requirePositive(grazing?.minS ?? BEHAVIOUR.grazeMinS, 'behaviour.grazing.minS', id),
    grazeMaxS: requirePositive(grazing?.maxS ?? BEHAVIOUR.grazeMaxS, 'behaviour.grazing.maxS', id),
    flareMinS: requirePositive(flare?.minS ?? BEHAVIOUR.flareMinS, 'behaviour.flare.minS', id),
    flareMaxS: requirePositive(flare?.maxS ?? BEHAVIOUR.flareMaxS, 'behaviour.flare.maxS', id),
    stationRadiusBodyLengths: requirePositive(
      station?.radiusBodyLengths ?? BEHAVIOUR.stationRadiusBodyLengths,
      'behaviour.station.radiusBodyLengths',
      id,
    ),
    restationMinS: requirePositive(
      station?.restationMinS ?? BEHAVIOUR.restationMinS,
      'behaviour.station.restationMinS',
      id,
    ),
    restationMaxS: requirePositive(
      station?.restationMaxS ?? BEHAVIOUR.restationMaxS,
      'behaviour.station.restationMaxS',
      id,
    ),
    shelterAfterStartleS: requirePositive(
      refuge?.afterStartleS ?? BEHAVIOUR.shelterAfterStartleS,
      'behaviour.refuge.afterStartleS',
      id,
    ),
    excursionMeanIntervalS: requirePositive(
      excursion?.meanIntervalS ?? BEHAVIOUR.excursionMeanIntervalS,
      'behaviour.excursion.meanIntervalS',
      id,
    ),
    hostLeashBodyLengths: requirePositive(
      excursion?.leashBodyLengths ?? BEHAVIOUR.hostLeashBodyLengths,
      'behaviour.excursion.leashBodyLengths',
      id,
    ),
  };
  requireOrdered(params.grazeMinS, params.grazeMaxS, 'grazing.minS/maxS', id);
  requireOrdered(params.flareMinS, params.flareMaxS, 'flare.minS/maxS', id);
  requireOrdered(
    params.restationMinS,
    params.restationMaxS,
    'station.restationMinS/restationMaxS',
    id,
  );
  return params;
}

export function toSimSpecies(input: SpeciesInput): SimSpecies {
  const { id, locomotion: loco, behaviour } = input;
  if (typeof input.lifecycle !== 'object' || input.lifecycle === null) {
    throw new RangeError(`species "${id}": lifecycle.diet is required`);
  }
  const maxSpeed = requirePositive(loco.maxSpeedMps, 'locomotion.maxSpeedMps', id);
  const cruiseSpeed = requirePositive(loco.cruiseSpeedMps, 'locomotion.cruiseSpeedMps', id);
  if (cruiseSpeed > maxSpeed) {
    throw new RangeError(`species "${id}": cruiseSpeedMps exceeds maxSpeedMps`);
  }
  const [depthLow, depthHigh] = behaviour.depthBand;
  if (!(depthLow >= 0 && depthHigh <= 1 && depthLow <= depthHigh)) {
    throw new RangeError(`species "${id}": depthBand must be [low, high] within [0, 1]`);
  }
  if (!(loco.maxPitchDeg >= 0 && loco.maxPitchDeg <= 90)) {
    throw new RangeError(`species "${id}": maxPitchDeg must be within [0, 90]`);
  }
  const neighbours = behaviour.schooling?.topologicalNeighbours ?? 0;
  const traits = parseTraits(id, behaviour.traits);
  const walking = parseWalking(id, input, traits, cruiseSpeed, maxSpeed);
  if (walking === null) requireReachable(id, traits, loco.gait);
  if (traits.has('shoal') && neighbours === 0) {
    throw new RangeError(`species "${id}": trait "shoal" needs a behaviour.schooling block`);
  }
  if (traits.has('flare-display') && !behaviour.territorial) {
    throw new RangeError(`species "${id}": trait "flare-display" needs territorial: true`);
  }
  const home: HomeKind = traits.has('anemone-host')
    ? 'anemone'
    : traits.has('cave-dweller')
      ? 'cave'
      : loco.gait === 'hover' && walking === null
        ? 'station'
        : 'none';
  if (!(behaviour.perceptionFovDeg > 0 && behaviour.perceptionFovDeg <= 360)) {
    throw new RangeError(`species "${id}": perceptionFovDeg must be within (0, 360]`);
  }
  return {
    id,
    gait: loco.gait,
    bodyLength: requirePositive(loco.bodyLengthM, 'locomotion.bodyLengthM', id),
    mass: requirePositive(loco.massKg, 'locomotion.massKg', id),
    maxSpeed,
    cruiseSpeed,
    maxTurnRate:
      requirePositive(loco.maxTurnRateDegPerS, 'locomotion.maxTurnRateDegPerS', id) * DEG,
    maxPitch: loco.maxPitchDeg * DEG,
    depthLow,
    depthHigh,
    perceptionRange: requirePositive(behaviour.perceptionRangeM, 'behaviour.perceptionRangeM', id),
    perceptionFov: behaviour.perceptionFovDeg * DEG,
    neighbours,
    schooling: neighbours > 0,
    shoal: traits.has('shoal'),
    tightenWhenStartled: behaviour.schooling?.tightenWhenStartled ?? false,
    territorial: behaviour.territorial,
    boldness: behaviour.boldness,
    curiosity: behaviour.curiosity,
    home,
    airGulp: traits.has('air-gulp'),
    grazer: traits.has('glass-grazer') ? 'glass' : traits.has('rock-grazer') ? 'rock' : 'none',
    flare: traits.has('flare-display'),
    bellyToSurface: traits.has('glass-grazer') || traits.has('cave-dweller'),
    foodPreference: parseDiet(id, input.lifecycle.diet),
    ...parseTraitParams(id, behaviour, traits, loco.gait, home, walking !== null),
    walking,
  };
}

function parseWalking(
  id: string,
  input: SpeciesInput,
  traits: ReadonlySet<Trait>,
  cruiseSpeed: number,
  maxSpeed: number,
): SimWalking | null {
  const { walking, swimmingMode } = input.locomotion;
  if (walking === undefined) {
    for (const t of WALKER_TRAITS) {
      if (traits.has(t)) {
        throw new RangeError(`species "${id}": trait "${t}" needs locomotion.walking`);
      }
    }
    return null;
  }
  if (swimmingMode !== 'pleopod') {
    throw new RangeError(`species "${id}": locomotion.walking needs swimmingMode "pleopod"`);
  }
  for (const t of SWIMMER_TRAITS) {
    if (traits.has(t)) {
      throw new RangeError(`species "${id}": trait "${t}" is for swimmers, not walkers`);
    }
  }
  if (input.behaviour.schooling !== undefined) {
    throw new RangeError(`species "${id}": walkers do not school; drop behaviour.schooling`);
  }
  if (input.behaviour.territorial) {
    throw new RangeError(`species "${id}": walkers hold no territory; set territorial: false`);
  }
  const walkSpeed = requirePositive(walking.walkSpeedMps, 'locomotion.walking.walkSpeedMps', id);
  if (walkSpeed > cruiseSpeed) {
    throw new RangeError(
      `species "${id}": locomotion.walking.walkSpeedMps ${walkSpeed} exceeds cruiseSpeedMps ${cruiseSpeed}`,
    );
  }
  const { tailFlip, surfaces } = walking;
  const flipSpeed = requirePositive(tailFlip.speedMps, 'locomotion.walking.tailFlip.speedMps', id);
  const flipPeak = flipSpeed * FLIP_PEAK_OVER_MEAN;
  // Small rounding slack, so a file giving the mean as max·2/π to a few digits still loads.
  if (flipPeak > maxSpeed * (1 + 1e-6)) {
    throw new RangeError(
      `species "${id}": tail-flip peak π/2 × ${flipSpeed} m/s exceeds maxSpeedMps ${maxSpeed}; ` +
        `tailFlip.speedMps is the mean and may be at most ${(maxSpeed / FLIP_PEAK_OVER_MEAN).toFixed(3)}`,
    );
  }
  if (surfaces.length === 0) {
    throw new RangeError(`species "${id}": locomotion.walking.surfaces must not be empty`);
  }
  return {
    walkSpeed,
    strideBodyLengths: requirePositive(
      walking.strideBodyLengths,
      'locomotion.walking.strideBodyLengths',
      id,
    ),
    legPairs: walking.legPairs,
    substrate: surfaces.includes('substrate'),
    decor: surfaces.includes('decor'),
    glass: surfaces.includes('glass'),
    flipSpeed,
    flipPeak: Math.min(flipPeak, maxSpeed),
    flipDurationS: requirePositive(tailFlip.durationS, 'locomotion.walking.tailFlip.durationS', id),
    flipRefractoryS: requirePositive(
      tailFlip.refractoryS,
      'locomotion.walking.tailFlip.refractoryS',
      id,
    ),
    biofilmGrazer: traits.has('biofilm-grazer'),
  };
}
