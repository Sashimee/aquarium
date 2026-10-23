import type { PlantPatch } from '@aquarium/shared';

export interface PlantInstance {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly tiltX: number;
  readonly tiltZ: number;
  readonly scale: number;
  /** Multiplies the leaf colour, 1 is the texture as shipped. */
  readonly tone: number;
}

export interface Extent {
  readonly halfLength: number;
  readonly halfDepth: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Horizontal extent of a plant of `scale` from its root, sway included. Without an `axis` it is
 * the worst case over both; with one, only what lands on that tank axis.
 */
export type ReachFn = (scale: number, axis?: 'x' | 'z') => number;

export const MAX_TILT_RAD = 0.1;
export const ROOT_DEPTH = 0.004;
const ATTEMPTS_PER_PLANT = 40;
/** Smallest share of its drawn scale a plant shrinks to, before it is moved to make room instead. */
export const GLASS_SHRINK_FLOOR = 0.5;

/**
 * The scale a plant may keep when rooted `room` metres from the nearest glass. Plants shrink first,
 * down to `GLASS_SHRINK_FLOOR`, so a patch authored near a wall stays there; only the remainder is
 * handled by moving the root.
 */
export function scaleForRoom(
  drawnScale: number,
  room: number,
  reach: ReachFn,
  axis?: 'x' | 'z',
): number {
  if (reach(drawnScale, axis) <= room) return drawnScale;
  const base = reach(0, axis);
  const slope = reach(1, axis) - base;
  const fitting = slope > 0 ? (room - base) / slope : drawnScale;
  return Math.min(drawnScale, Math.max(drawnScale * GLASS_SHRINK_FLOOR, fitting));
}

/**
 * `reach(scale)` is how far a plant of that scale extends horizontally from its root, including
 * its sway, so the whole plant stays inside `extent` and never touches the glass.
 *
 * Dart-throws `patch.count` plants into a disc, keeping a spacing that shrinks if the disc is too
 * crowded to honour. The result is ordered so that any prefix is also evenly spread, which is how
 * the quality tier thins a patch without moving the survivors.
 *
 * A plant too big for the room at its sampled spot shrinks (see `scaleForRoom`) before it is moved,
 * so patch depth is honoured even where a species' reach is close to the tank's half-depth.
 *
 * `scaleCeiling(rootY)` caps a plant's scale from where it roots, which keeps tall stems under the
 * water line.
 */
export function scatterPatch(
  patch: PlantPatch,
  ground: (x: number, z: number) => number,
  blocked: (x: number, y: number, z: number) => boolean,
  extent: Extent,
  reach: ReachFn = () => 0,
  scaleCeiling: (rootY: number) => number = () => Infinity,
): PlantInstance[] {
  const rng = mulberry32(patch.seed);
  const [cx, cz] = patch.center;
  const area = Math.PI * patch.radius * patch.radius;
  let spacing = 0.7 * Math.sqrt(area / patch.count);
  const placed: PlantInstance[] = [];
  const [minScale, maxPatchScale] = patch.scale;

  let failures = 0;
  while (placed.length < patch.count) {
    const r = patch.radius * Math.sqrt(rng());
    const a = rng() * Math.PI * 2;
    const yaw = rng() * Math.PI * 2;
    const tiltX = (rng() - 0.5) * 2 * MAX_TILT_RAD;
    const tiltZ = (rng() - 0.5) * 2 * MAX_TILT_RAD;
    const drawnScale = minScale + (maxPatchScale - minScale) * rng();
    const tone = 0.88 + 0.2 * rng();
    const wantX = cx + Math.cos(a) * r;
    const wantZ = cz + Math.sin(a) * r;
    const fitted = Math.min(
      scaleForRoom(drawnScale, extent.halfLength - Math.abs(wantX), reach, 'x'),
      scaleForRoom(drawnScale, extent.halfDepth - Math.abs(wantZ), reach, 'z'),
    );
    const limitX = Math.max(0, extent.halfLength - reach(fitted, 'x'));
    const limitZ = Math.max(0, extent.halfDepth - reach(fitted, 'z'));
    const x = Math.min(limitX, Math.max(-limitX, wantX));
    const z = Math.min(limitZ, Math.max(-limitZ, wantZ));
    const y = ground(x, z) - ROOT_DEPTH;
    const scale = Math.min(fitted, scaleCeiling(y));
    const crowded = placed.some((p) => Math.hypot(p.x - x, p.z - z) < spacing);
    const rejected = crowded || blocked(x, y, z);
    if (rejected) {
      failures++;
      if (failures >= ATTEMPTS_PER_PLANT) {
        spacing *= 0.85;
        failures = 0;
      }
      if (spacing < 1e-3) break;
      continue;
    }
    failures = 0;
    placed.push({ x, y, z, yaw, tiltX, tiltZ, scale, tone });
  }
  return placed;
}

const OPEN_SAMPLES = 24;
const OPEN_STEPS = 12;
/** A disc at least this open keeps its place. */
const SMOTHERED_SHARE = 0.5;
/** Open share `openGround` looks for before settling for the most open spot. */
const OPEN_TARGET = 0.85;

export function openShare(
  x: number,
  z: number,
  radius: number,
  isOpen: (x: number, z: number) => boolean,
): number {
  let open = 0;
  for (let i = 0; i < OPEN_SAMPLES; i++) {
    const r = radius * Math.sqrt((i + 0.5) / OPEN_SAMPLES);
    const a = i * 2.399963229728653;
    if (isOpen(x + Math.cos(a) * r, z + Math.sin(a) * r)) open++;
  }
  return open / OPEN_SAMPLES;
}

/**
 * Where a patch that hardscape mostly smothers can root instead: the nearest spot on its own side
 * of the tank, inside `limitX`/`limitZ` and no shallower than it started, whose ground is
 * `OPEN_TARGET` open (else the most open one). A disc at least half open stays where it is, so
 * only patches whose plants would pile into a gap move.
 */
export function openGround(
  center: readonly [number, number],
  radius: number,
  limitX: number,
  limitZ: number,
  isOpen: (x: number, z: number) => boolean,
): [number, number] {
  const [x, z] = center;
  if (openShare(x, z, radius, isOpen) >= SMOTHERED_SHARE) return [x, z];
  const [loX, hiX] = x < 0 ? [-limitX, 0] : [0, limitX];
  const [loZ, hiZ] = z < 0 ? [Math.min(-limitZ, z), z] : [z, Math.max(limitZ, z)];
  let best: [number, number] = [x, z];
  let bestShare = -1;
  let bestMove = Infinity;
  for (let i = 0; i <= OPEN_STEPS; i++) {
    for (let j = 0; j <= OPEN_STEPS; j++) {
      const cx = loX + ((hiX - loX) * i) / OPEN_STEPS;
      const cz = loZ + ((hiZ - loZ) * j) / OPEN_STEPS;
      const share = Math.min(OPEN_TARGET, openShare(cx, cz, radius, isOpen));
      const move = Math.hypot(cx - x, cz - z);
      if (share > bestShare || (share === bestShare && move < bestMove)) {
        best = [cx, cz];
        bestShare = share;
        bestMove = move;
      }
    }
  }
  return best;
}
