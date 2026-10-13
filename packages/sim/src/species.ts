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
): TraitParams {
  const { airGulp, grazing, flare, station, refuge, excursion } = behaviour;
  const forager = gait === 'forage';
  const homed = !forager && !traits.has('glass-grazer') && home !== 'none';
  const free = !forager && !traits.has('glass-grazer') && home === 'none';
  const owners: [string, unknown, boolean, string][] = [
    ['airGulp', airGulp, forager && traits.has('air-gulp'), 'trait "air-gulp" and gait "forage"'],
    [
      'grazing',
      grazing,
      free && traits.has('rock-grazer'),
      'trait "rock-grazer" on a species with no home and a gait other than "hover" or "forage"',
    ],
    ['flare', flare, traits.has('flare-display'), 'trait "flare-display"'],
    [
      'station',
      station,
      homed,
      'gait "hover" or an anemone or cave home, without gait "forage" or trait "glass-grazer"',
    ],
    [
      'refuge',
      refuge,
      homed && traits.has('cave-dweller'),
      'trait "cave-dweller" without gait "forage" or trait "glass-grazer"',
    ],
    [
      'excursion',
      excursion,
      homed && traits.has('anemone-host'),
      'trait "anemone-host" without gait "forage" or trait "glass-grazer"',
    ],
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
      : loco.gait === 'hover'
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
    ...parseTraitParams(id, behaviour, traits, loco.gait, home),
  };
}
