import { traitSchema, type Species } from '@aquarium/shared';
import { DEG } from './math.ts';

export type SpeciesInput = Pick<Species, 'id' | 'behaviour' | 'locomotion'>;

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
}

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

function requirePositive(value: number, field: string, id: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`species "${id}": ${field} must be a positive number, got ${value}`);
  }
  return value;
}

export function toSimSpecies(input: SpeciesInput): SimSpecies {
  const { id, locomotion: loco, behaviour } = input;
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
  };
}
