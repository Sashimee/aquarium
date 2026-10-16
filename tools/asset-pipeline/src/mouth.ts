import type { Primitive } from '@gltf-transform/core';
import { MOUTH_ATTRIBUTE } from './index-schema.ts';
import { clamp } from './math.ts';

export interface MouthHints {
  /** Length of the head as a fraction of the body length (snout to peduncle); the mask is 0 behind it. */
  headFraction?: number;
  /** Distance of the mouth slit below the nose landmark, in head heights. */
  jawDrop?: number;
}

const DEFAULT_HEAD_FRACTION = 0.2;
const DEFAULT_JAW_DROP = 0.12;
const VERTICAL_SOFTNESS = 0.2;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Per-vertex mouth weight for buccal motion: 1 at the jaw tip (the front-most, lowest point of the head), easing to 0
 * behind the gill line (`headFraction` of the body length behind the snout) and above the mouth slit. The nose landmark
 * is the front-most body vertex; the slit sits `jawDrop` head heights below it. Fin vertices (`finId` != 0) stay 0.
 */
export function bakeMouthMask(
  positions: Float32Array,
  finId: Float32Array,
  hints: MouthHints = {},
): Float32Array<ArrayBuffer> {
  const count = positions.length / 3;
  let zSnout = -Infinity;
  let zRear = Infinity;
  let nose = -1;
  for (let i = 0; i < count; i++) {
    if (finId[i] !== 0) continue;
    const z = positions[i * 3 + 2]!;
    if (z > zSnout) {
      zSnout = z;
      nose = i;
    }
    zRear = Math.min(zRear, z);
  }
  if (nose < 0) throw new Error('bakeMouthMask: no body vertex to find the nose on');
  const headLength = (hints.headFraction ?? DEFAULT_HEAD_FRACTION) * (zSnout - zRear);
  if (!(headLength > 0)) throw new Error('bakeMouthMask: the body has no length along +z');

  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < count; i++) {
    if (finId[i] !== 0 || zSnout - positions[i * 3 + 2]! > headLength) continue;
    yMin = Math.min(yMin, positions[i * 3 + 1]!);
    yMax = Math.max(yMax, positions[i * 3 + 1]!);
  }
  const headHeight = Math.max(yMax - yMin, 1e-9);
  const slitY = positions[nose * 3 + 1]! - (hints.jawDrop ?? DEFAULT_JAW_DROP) * headHeight;

  const mask = new Float32Array(count);
  let peak = 0;
  for (let i = 0; i < count; i++) {
    if (finId[i] !== 0) continue;
    const behind = zSnout - positions[i * 3 + 2]!;
    if (behind > headLength) continue;
    const lengthwise = smoothstep(0, 1, 1 - behind / headLength);
    const below = (slitY - positions[i * 3 + 1]!) / headHeight;
    const weight = lengthwise * smoothstep(-VERTICAL_SOFTNESS, VERTICAL_SOFTNESS, below);
    mask[i] = weight;
    peak = Math.max(peak, weight);
  }
  if (peak <= 0) throw new Error('bakeMouthMask: no head vertex lies below the mouth slit');
  for (let i = 0; i < count; i++) mask[i] = mask[i]! / peak;
  return mask;
}

/**
 * Simplification can drop the jaw-tip vertex, which would shrink the buccal amplitude from one LOD to the next; scales
 * the mask over all primitives of one mesh so the highest remaining value is 1 again.
 */
export function renormaliseMouth(primitives: Primitive[]): void {
  const accessors = primitives
    .map((prim) => prim.getAttribute(MOUTH_ATTRIBUTE))
    .filter((accessor) => accessor !== null);
  let peak = 0;
  for (const accessor of accessors)
    for (const value of accessor.getArray() ?? []) peak = Math.max(peak, value);
  if (peak <= 0 || peak === 1) return;
  for (const accessor of accessors) {
    const values = Float32Array.from(accessor.getArray() ?? [], (v) => Math.min(1, v / peak));
    accessor.setArray(values);
  }
}
