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

export interface MeshRank {
  /** Length-normalised camera distance, as `effectiveDistance`. */
  distance: number;
  /** Drawn as a full mesh; read as last frame's choice, written with this frame's. */
  full: boolean;
  /** Scratch for `markNearest`'s sort. */
  rankKey: number;
}

const byRankKey = (a: MeshRank, b: MeshRank): number => a.rankKey - b.rankKey;

/**
 * Lets only the `limit` nearest fish draw as full meshes. One that already does keeps its place
 * until another is 8% nearer, so two fish at about the same distance do not trade it every frame.
 * Sorts `items` nearest first.
 */
export function markNearest(items: MeshRank[], limit: number): void {
  if (!(limit >= 0)) throw new RangeError(`lod: mesh limit must be >= 0, got ${limit}`);
  for (const item of items) item.rankKey = item.distance * (item.full ? 1 - HYSTERESIS : 1);
  items.sort(byRankKey);
  let rank = 0;
  for (const item of items) item.full = rank++ < limit;
}

/** The level an impostor stands in for. */
export const IMPOSTOR_LOD = 2;

export interface ImpostorChoice {
  /** The tier draws impostors at all. */
  tierImpostors: boolean;
  /** The species has a built impostor (a ready atlas, a swimming fish); else lod2 stays a mesh. */
  available: boolean;
  lod: number;
  /** Among the tier's nearest fish, as `markNearest` marks them. */
  full: boolean;
  /** Its mesh at `lod` casts a shadow on this tier. */
  castsShadow: boolean;
  /**
   * The larger of its fin spread and gill flare in display, 0..1, which the atlas has neither of;
   * 0 for a species whose mesh does not show display either.
   */
  display: number;
}

/** Below this the sim's easing display has faded to nothing visible, if not yet to 0. */
const DISPLAY_SHOWN = 0.01;

/**
 * Whether a fish draws as an impostor instead of its LOD mesh. Past lod2 it does. Nearer, a
 * fish outside the nearest few swaps too, unless its mesh casts a shadow: the impostor casts none,
 * and a shadow vanishing as a fish drops a rank pops, while a tier with fish shadows already pays
 * for that mesh in its shadow pass.
 *
 * A fish in display keeps its mesh at any distance. The atlas is baked with the fins at rest, and a
 * second, flared atlas per displaying species would cost more than the few such fish (a betta at a
 * mirror or a rival) drawn as meshes. The swap happens with the fins all but closed, so it does
 * not pop.
 */
export function drawsAsImpostor(c: Readonly<ImpostorChoice>): boolean {
  if (!c.tierImpostors || !c.available || c.display > DISPLAY_SHOWN) return false;
  if (c.lod >= IMPOSTOR_LOD) return true;
  return !c.full && !c.castsShadow;
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
