import {
  type CompressedTexture,
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
 * Per-instance impostor data, interleaved as six vec4s:
 * - `orientation`: the instance quaternion, to light the baked fish-space normals;
 * - `swim`: as the meshes' (scale, body-wave phase, amplitude scale, turn curvature in model units);
 * - `view`: unit direction from the pivot to the camera in fish space, paling 0..1;
 * - `tint`: rgb multiplier, youth as the meshes';
 * - `frames`: the blended frames' (i, j) and bilinear weights (fx, fy), see `selectFrames`;
 * - `illness`: ich, fin rot and velvet severities 0..1, unused, at the meshes' offset.
 */
export const IMPOSTOR_STRIDE = 24;
export const ImpostorSlot = {
  Orientation: 0,
  Swim: 4,
  View: 8,
  Tint: 12,
  Frames: 16,
  Illness: 20,
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
  youth: number;
  frames: Readonly<FrameSelection>;
  ich: number;
  finRot: number;
  velvet: number;
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
    a[o + 15] = v.youth;
    a[o + 16] = v.frames.i;
    a[o + 17] = v.frames.j;
    a[o + 18] = v.frames.fx;
    a[o + 19] = v.frames.fy;
    a[o + 20] = v.ich;
    a[o + 21] = v.finRot;
    a[o + 22] = v.velvet;
  }

  /**
   * Zero scale, so a collapsed instance rasterises nothing. The view stays a unit vector: the strip's
   * basis normalises it, and a zero view would put NaN in every vertex of the warm-up draw.
   */
  collapse(index: number): void {
    const o = this.offset(index);
    this.array.fill(0, o, o + IMPOSTOR_STRIDE);
    this.array[o + ImpostorSlot.View] = 1;
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

/** The bake's smallest frame, which the normal atlas is never shrunk below. */
const MIN_NORMAL_FRAME_SIZE = 64;

/**
 * Top mip levels of the normal atlas that are not uploaded. Impostors draw only on the tiers that
 * load 1k maps, for fish too far or too many to earn a mesh, and their normals light a picture
 * the albedo already shades: at 128 px frames the full-size normal atlas was the largest single
 * map left in a phone's tank. Frames stay at least `MIN_NORMAL_FRAME_SIZE`, so a small fish's
 * 64 px atlas keeps every level.
 */
export function droppedNormalLevels(frameSize: number): number {
  let dropped = 0;
  while (frameSize >> (dropped + 1) >= MIN_NORMAL_FRAME_SIZE) dropped++;
  return dropped;
}

/**
 * Shrinks the normal atlas to the size `droppedNormalLevels` leaves it at. three hands overlapping
 * loads of one URL the same texture, so this reads how far it is already shrunk from its width
 * instead of dropping levels again.
 */
function shrinkNormalAtlas(texture: CompressedTexture, info: ImpostorAtlasInfo): Texture {
  const levels = droppedNormalLevels(info.frameSize);
  if (levels === 0) return texture;
  const file = info.normalFile;
  const atlasSize = info.grid * info.frameSize;
  const shrunkSize = atlasSize >> levels;
  const { width } = texture.image;
  if (width === shrunkSize) return texture;
  const partial = Array.from({ length: levels - 1 }, (_, i) => i + 1).find(
    (dropped) => width === atlasSize >> dropped,
  );
  if (partial !== undefined) {
    throw new Error(
      `${file} is ${width} px wide: ${partial} of the ${levels} mip levels its ${info.frameSize} px frames drop are already gone. Something else shrank this shared texture; load it only through loadImpostorAtlas.`,
    );
  }
  if (width !== atlasSize) {
    throw new Error(
      `${file} is ${width} px wide, but grid * frameSize is ${atlasSize}. Re-bake it or fix its index entry.`,
    );
  }
  const kept = texture.mipmaps.slice(levels);
  const top = kept[0];
  if (top === undefined) {
    throw new Error(
      `${file} has ${texture.mipmaps.length} mip levels; the impostor needs more than ${levels}. Re-bake it with mips.`,
    );
  }
  texture.mipmaps = kept;
  texture.image = { width: top.width, height: top.height };
  return texture;
}

function prepare(texture: Texture): Texture {
  texture.magFilter = LinearFilter;
  texture.minFilter = texture.mipmaps.length > 1 ? LinearMipmapLinearFilter : LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

/**
 * three returns the same texture to overlapping loads of one URL. Disposing it while another
 * atlas still draws with it would make three upload it again from its CPU mips.
 */
const textureUsers = new WeakMap<Texture, number>();

function retain(texture: Texture): void {
  textureUsers.set(texture, (textureUsers.get(texture) ?? 0) + 1);
}

function release(texture: Texture): void {
  const users = textureUsers.get(texture);
  if (users === undefined) {
    throw new Error(
      `fish impostor texture ${texture.name || texture.uuid} was released more often than it was loaded`,
    );
  }
  if (users > 1) {
    textureUsers.set(texture, users - 1);
    return;
  }
  textureUsers.delete(texture);
  texture.dispose();
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
  for (const texture of loaded) retain(texture);
  const [albedo, normal] = loaded;
  if (loaded.length === 2 && albedo !== undefined && normal !== undefined) {
    try {
      const shrunk = shrinkNormalAtlas(normal, info);
      return { info, albedo: prepare(albedo), normal: prepare(shrunk) };
    } catch (error) {
      for (const texture of loaded) release(texture);
      throw error;
    }
  }
  for (const texture of loaded) release(texture);
  const failed = settled.findIndex((r) => r.status === 'rejected');
  const failure = settled[failed];
  throw new Error(`fish impostor atlas ${files[failed] ?? info.albedoFile} failed to load`, {
    cause: failure?.status === 'rejected' ? failure.reason : undefined,
  });
}

/** Disposes each texture once no other atlas from an overlapping load still uses it. */
export function releaseImpostorAtlas(atlas: ImpostorAtlas): void {
  release(atlas.albedo);
  release(atlas.normal);
}
