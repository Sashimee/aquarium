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

/** LOD levels whose meshes keep enough jaw vertices to move the mouth. */
export const MOUTH_LODS = 2;

/**
 * Mouth motion fades out across the mid band and is gone before a fish can switch to lod2, so it
 * neither pops at the switch nor spikes the few jaw vertices simplification leaves there.
 */
export function mouthFade(distance: number, length: number, thresholds: LodThresholds): number {
  const d = effectiveDistance(distance, length);
  const start = thresholds.midDistance;
  const end = thresholds.impostorDistance * (1 - HYSTERESIS);
  if (!(end > start)) return d < end ? 1 : 0;
  const t = Math.min(Math.max((d - start) / (end - start), 0), 1);
  return 1 - t * t * (3 - 2 * t);
}
