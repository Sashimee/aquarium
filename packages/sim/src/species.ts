import type { Species } from '@aquarium/shared';
import { DEG } from './math.ts';

export type SpeciesInput = Pick<Species, 'id' | 'behaviour' | 'locomotion'>;

export const WATER_DENSITY = 1000;

/**
 * Drag F = ½·ρ·C·L²·v², referenced to body length squared. C ≈ laminar skin friction at
 * Re 10⁴–10⁵ (Blasius Cf ≈ 1.33·Re^-½ ≈ 0.005–0.013) × wetted area ≈ 0.4·L² × ~3 for the
 * swimming-induced boundary-layer thinning (Lighthill 1971; Anderson et al. 2001).
 */
export const DRAG_COEFFICIENT_L2 = 0.02;

export interface SimSpecies {
  readonly id: string;
  readonly bodyLength: number;
  readonly mass: number;
  readonly maxSpeed: number;
  readonly cruiseSpeed: number;
  readonly maxTurnRate: number;
  readonly maxPitch: number;
  readonly depthLow: number;
  readonly depthHigh: number;
  readonly perceptionRange: number;
  readonly neighbours: number;
  readonly schooling: boolean;
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
  return {
    id,
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
    neighbours,
    schooling: neighbours > 0,
  };
}
