import { DynamicDrawUsage, InstancedInterleavedBuffer } from 'three/webgpu';

/**
 * Per-instance swim and look data, interleaved as six vec4s:
 * - `orientation`: the instance quaternion (x, y, z, w), needed again by the shadow pass;
 * - `swim`: scale, body-wave phase, amplitude scale, turn curvature in model units;
 * - `look`: fin phase, paling 0..1, seed 0..1, iridescent film thickness (nm);
 * - `tint`: rgb multiplier, gill opening 0..1;
 * - `breath`: mouth opening 0..1, display fin spread 0..1, display gill flare 0..1, unused; walkers
 *   have no mouth or display and leave the block at 0;
 * - `illness`: ich, fin rot and velvet severities 0..1, unused; walkers catch none of these
 *   diseases and leave the block at 0.
 * Walkers add two more: `walk` (leg phase 0..1, stride weight, tail curl in radians, pleopod
 * paddling) and `act` (cheliped picking, antenna display, unused, unused).
 */
export const INSTANCE_STRIDE = 24;
export const WALKER_INSTANCE_STRIDE = 32;
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
  Gills: 15,
  Mouth: 16,
  Display: 17,
  GillFlare: 18,
  Ich: 20,
  FinRot: 21,
  Velvet: 22,
} as const;
export const WalkerSlot = {
  LegPhase: 24,
  Stride: 25,
  Curl: 26,
  Paddle: 27,
  Pick: 28,
  Dance: 29,
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
  gills: number;
  mouth: number;
  display: number;
  gillFlare: number;
  ich: number;
  finRot: number;
  velvet: number;
}

export interface WalkerValues {
  legPhase: number;
  stride: number;
  curl: number;
  paddle: number;
  pick: number;
  dance: number;
}

export class FishInstanceData {
  readonly array: Float32Array;
  readonly buffer: InstancedInterleavedBuffer;

  constructor(
    readonly capacity: number,
    readonly stride: typeof INSTANCE_STRIDE | typeof WALKER_INSTANCE_STRIDE = INSTANCE_STRIDE,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`fish instances: capacity must be a positive integer, got ${capacity}`);
    }
    this.array = new Float32Array(capacity * stride);
    this.buffer = new InstancedInterleavedBuffer(this.array, stride);
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
    a[o + InstanceSlot.Gills] = v.gills;
    a[o + InstanceSlot.Mouth] = v.mouth;
    a[o + InstanceSlot.Display] = v.display;
    a[o + InstanceSlot.GillFlare] = v.gillFlare;
    a[o + InstanceSlot.Ich] = v.ich;
    a[o + InstanceSlot.FinRot] = v.finRot;
    a[o + InstanceSlot.Velvet] = v.velvet;
  }

  writeWalker(index: number, v: WalkerValues): void {
    if (this.stride !== WALKER_INSTANCE_STRIDE) {
      throw new Error('fish instances: walker values need a buffer built with the walker stride');
    }
    const a = this.array;
    const o = this.offset(index);
    a[o + WalkerSlot.LegPhase] = v.legPhase;
    a[o + WalkerSlot.Stride] = v.stride;
    a[o + WalkerSlot.Curl] = v.curl;
    a[o + WalkerSlot.Paddle] = v.paddle;
    a[o + WalkerSlot.Pick] = v.pick;
    a[o + WalkerSlot.Dance] = v.dance;
  }

  /** Zero scale, so the swim deformation adds nothing to a collapsed instance matrix. */
  collapse(index: number): void {
    const o = this.offset(index);
    this.array.fill(0, o, o + this.stride);
  }

  commit(): void {
    this.buffer.needsUpdate = true;
  }

  private offset(index: number): number {
    if (!(index >= 0 && index < this.capacity)) {
      throw new RangeError(`fish instances: index ${index} outside 0..${this.capacity - 1}`);
    }
    return index * this.stride;
  }
}
