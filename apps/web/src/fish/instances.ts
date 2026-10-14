import { DynamicDrawUsage, InstancedInterleavedBuffer } from 'three/webgpu';

/**
 * Per-instance swim and look data, interleaved as four vec4s:
 * - `orientation`: the instance quaternion (x, y, z, w), needed again by the shadow pass;
 * - `swim`: scale, body-wave phase, amplitude scale, turn curvature in model units;
 * - `look`: fin phase, paling 0..1, seed 0..1, iridescent film thickness (nm);
 * - `tint`: rgb multiplier, w unused.
 */
export const INSTANCE_STRIDE = 16;
export const InstanceSlot = {
  QuatX: 0,
  QuatY: 1,
  QuatZ: 2,
  QuatW: 3,
  Scale: 4,
  Phase: 5,
  Amplitude: 6,
  Curvature: 7,
  FinPhase: 8,
  Pale: 9,
  Seed: 10,
  FilmThickness: 11,
  TintR: 12,
  TintG: 13,
  TintB: 14,
} as const;

export interface InstanceValues {
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  scale: number;
  phase: number;
  amplitude: number;
  curvature: number;
  finPhase: number;
  pale: number;
  seed: number;
  filmThickness: number;
  tint: readonly [number, number, number];
}

export class FishInstanceData {
  readonly array: Float32Array;
  readonly buffer: InstancedInterleavedBuffer;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`fish instances: capacity must be a positive integer, got ${capacity}`);
    }
    this.array = new Float32Array(capacity * INSTANCE_STRIDE);
    this.buffer = new InstancedInterleavedBuffer(this.array, INSTANCE_STRIDE);
    this.buffer.setUsage(DynamicDrawUsage);
  }

  write(index: number, v: InstanceValues): void {
    const a = this.array;
    const o = this.offset(index);
    a[o + InstanceSlot.QuatX] = v.qx;
    a[o + InstanceSlot.QuatY] = v.qy;
    a[o + InstanceSlot.QuatZ] = v.qz;
    a[o + InstanceSlot.QuatW] = v.qw;
    a[o + InstanceSlot.Scale] = v.scale;
    a[o + InstanceSlot.Phase] = v.phase;
    a[o + InstanceSlot.Amplitude] = v.amplitude;
    a[o + InstanceSlot.Curvature] = v.curvature;
    a[o + InstanceSlot.FinPhase] = v.finPhase;
    a[o + InstanceSlot.Pale] = v.pale;
    a[o + InstanceSlot.Seed] = v.seed;
    a[o + InstanceSlot.FilmThickness] = v.filmThickness;
    a[o + InstanceSlot.TintR] = v.tint[0];
    a[o + InstanceSlot.TintG] = v.tint[1];
    a[o + InstanceSlot.TintB] = v.tint[2];
  }

  /** Zero scale, so the swim deformation adds nothing to a collapsed instance matrix. */
  collapse(index: number): void {
    const o = this.offset(index);
    this.array.fill(0, o, o + INSTANCE_STRIDE);
  }

  commit(): void {
    this.buffer.needsUpdate = true;
  }

  private offset(index: number): number {
    if (!(index >= 0 && index < this.capacity)) {
      throw new RangeError(`fish instances: index ${index} outside 0..${this.capacity - 1}`);
    }
    return index * INSTANCE_STRIDE;
  }
}
