export const LOD_LEVELS = 3;

/** Tier LOD distances are tuned for a fish of this length; bigger fish switch further away. */
export const REFERENCE_LENGTH_M = 0.05;
const HYSTERESIS = 0.08;

export interface LodThresholds {
  readonly midDistance: number;
  readonly impostorDistance: number;
}

export function effectiveDistance(distance: number, length: number): number {
  if (!(length > 0)) throw new RangeError(`lod: body length must be > 0, got ${length}`);
  return (distance * REFERENCE_LENGTH_M) / length;
}

/**
 * Picks lod0..lod2 from the length-normalised camera distance. A fish only changes level once it
 * is 8% past a threshold, so one hovering on the boundary does not flicker between meshes.
 */
export function selectLod(
  distance: number,
  length: number,
  thresholds: LodThresholds,
  current: number,
  available: number = LOD_LEVELS,
): number {
  if (!(available >= 1)) throw new RangeError(`lod: need at least one level, got ${available}`);
  const d = effectiveDistance(distance, length);
  const bounds = [thresholds.midDistance, thresholds.impostorDistance];
  let level = 0;
  for (let i = 0; i < bounds.length; i++) {
    const bound = bounds[i] ?? Infinity;
    const margin = current > i ? 1 - HYSTERESIS : 1 + HYSTERESIS;
    if (d > bound * margin) level = i + 1;
  }
  return Math.min(level, available - 1);
}
