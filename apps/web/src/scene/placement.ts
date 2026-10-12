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

const MAX_TILT_RAD = 0.1;
const ROOT_DEPTH = 0.004;
const ATTEMPTS_PER_PLANT = 40;

/**
 * Dart-throws `patch.count` plants into a disc, keeping a spacing that shrinks if the disc is too
 * crowded to honour. The result is ordered so that any prefix is also evenly spread, which is how
 * the quality tier thins a patch without moving the survivors.
 */
export function scatterPatch(
  patch: PlantPatch,
  ground: (x: number, z: number) => number,
  blocked: (x: number, y: number, z: number) => boolean,
  extent: Extent,
): PlantInstance[] {
  const rng = mulberry32(patch.seed);
  const [cx, cz] = patch.center;
  const area = Math.PI * patch.radius * patch.radius;
  let spacing = 0.7 * Math.sqrt(area / patch.count);
  const placed: PlantInstance[] = [];
  const [minScale, maxScale] = patch.scale;

  let failures = 0;
  while (placed.length < patch.count) {
    const r = patch.radius * Math.sqrt(rng());
    const a = rng() * Math.PI * 2;
    const x = Math.min(extent.halfLength, Math.max(-extent.halfLength, cx + Math.cos(a) * r));
    const z = Math.min(extent.halfDepth, Math.max(-extent.halfDepth, cz + Math.sin(a) * r));
    const y = ground(x, z) - ROOT_DEPTH;
    const crowded = placed.some((p) => Math.hypot(p.x - x, p.z - z) < spacing);
    const rejected = crowded || blocked(x, y, z);
    // Draw the per-plant values even for rejected darts so a prefix does not depend on them.
    const yaw = rng() * Math.PI * 2;
    const tiltX = (rng() - 0.5) * 2 * MAX_TILT_RAD;
    const tiltZ = (rng() - 0.5) * 2 * MAX_TILT_RAD;
    const scale = minScale + (maxScale - minScale) * rng();
    const tone = 0.88 + 0.2 * rng();
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
