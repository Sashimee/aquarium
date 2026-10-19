import {
  DynamicDrawUsage,
  InstancedInterleavedBuffer,
  LinearFilter,
  LinearMipmapLinearFilter,
  PlaneGeometry,
  type Texture,
} from 'three/webgpu';
import type { Ktx2Textures } from '../engine/ktx2';
import type { ImpostorAtlasInfo } from './assetIndex';
import type { FrameSelection } from './octahedral';

/**
 * Per-instance impostor data, interleaved as five vec4s:
 * - `orientation`: the instance quaternion, to light the baked fish-space normals;
 * - `swim`: as the meshes' (scale, body-wave phase, amplitude scale, turn curvature in model units);
 * - `view`: unit direction from the pivot to the camera in fish space, paling 0..1;
 * - `tint`: rgb multiplier, unused;
 * - `frames`: the blended frames' (i, j) and bilinear weights (fx, fy), see `selectFrames`.
 */
export const IMPOSTOR_STRIDE = 20;
export const ImpostorSlot = {
  Orientation: 0,
  Swim: 4,
  View: 8,
  Tint: 12,
  Frames: 16,
} as const;

export interface ImpostorValues {
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  scale: number;
  phase: number;
  amplitude: number;
  curvature: number;
  viewX: number;
  viewY: number;
  viewZ: number;
  pale: number;
  tint: readonly [number, number, number];
  frames: Readonly<FrameSelection>;
}

export class ImpostorInstanceData {
  readonly array: Float32Array;
  readonly buffer: InstancedInterleavedBuffer;
  readonly stride = IMPOSTOR_STRIDE;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`fish impostors: capacity must be a positive integer, got ${capacity}`);
    }
    this.array = new Float32Array(capacity * IMPOSTOR_STRIDE);
    this.buffer = new InstancedInterleavedBuffer(this.array, IMPOSTOR_STRIDE);
    this.buffer.setUsage(DynamicDrawUsage);
  }

  write(index: number, v: ImpostorValues): void {
    const a = this.array;
    const o = this.offset(index);
    a[o] = v.qx;
    a[o + 1] = v.qy;
    a[o + 2] = v.qz;
    a[o + 3] = v.qw;
    a[o + 4] = v.scale;
    a[o + 5] = v.phase;
    a[o + 6] = v.amplitude;
    a[o + 7] = v.curvature;
    a[o + 8] = v.viewX;
    a[o + 9] = v.viewY;
    a[o + 10] = v.viewZ;
    a[o + 11] = v.pale;
    a[o + 12] = v.tint[0];
    a[o + 13] = v.tint[1];
    a[o + 14] = v.tint[2];
    a[o + 15] = 0;
    a[o + 16] = v.frames.i;
    a[o + 17] = v.frames.j;
    a[o + 18] = v.frames.fx;
    a[o + 19] = v.frames.fy;
  }

  /** Zero scale and a zero radius on the strip, so a collapsed instance rasterises nothing. */
  collapse(index: number): void {
    const o = this.offset(index);
    this.array.fill(0, o, o + IMPOSTOR_STRIDE);
  }

  commit(): void {
    this.buffer.needsUpdate = true;
  }

  private offset(index: number): number {
    if (!(index >= 0 && index < this.capacity)) {
      throw new RangeError(`fish impostors: index ${index} outside 0..${this.capacity - 1}`);
    }
    return index * IMPOSTOR_STRIDE;
  }
}

/** Segments along the strip; the body wave is about one body length long, so 8 bend it smoothly. */
export const IMPOSTOR_SEGMENTS = 8;

/**
 * A strip of unit quads spanning [-1, 1] on x and y. x runs along the fish's body as seen by the
 * camera, so the body wave bends it segment by segment; y runs across it.
 */
export function impostorStrip(): PlaneGeometry {
  return new PlaneGeometry(2, 2, IMPOSTOR_SEGMENTS, 1);
}

export interface ImpostorAtlas {
  readonly info: ImpostorAtlasInfo;
  readonly albedo: Texture;
  readonly normal: Texture;
}

function prepare(texture: Texture): Texture {
  texture.magFilter = LinearFilter;
  texture.minFilter = texture.mipmaps.length > 1 ? LinearMipmapLinearFilter : LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

/** Loads both atlases of a fish; neither is kept when either fails. */
export async function loadImpostorAtlas(
  ktx2: Ktx2Textures,
  root: string,
  info: ImpostorAtlasInfo,
): Promise<ImpostorAtlas> {
  const files = [info.albedoFile, info.normalFile];
  const settled = await Promise.allSettled(files.map((file) => ktx2.loadAsync(`${root}${file}`)));
  const loaded = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const [albedo, normal] = loaded;
  if (loaded.length === 2 && albedo !== undefined && normal !== undefined) {
    return { info, albedo: prepare(albedo), normal: prepare(normal) };
  }
  for (const texture of loaded) texture.dispose();
  const failed = settled.findIndex((r) => r.status === 'rejected');
  const failure = settled[failed];
  throw new Error(`fish impostor atlas ${files[failed] ?? info.albedoFile} failed to load`, {
    cause: failure?.status === 'rejected' ? failure.reason : undefined,
  });
}

export function disposeImpostorAtlas(atlas: ImpostorAtlas): void {
  atlas.albedo.dispose();
  atlas.normal.dispose();
}
