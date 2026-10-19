import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeToKTX2 } from 'ktx2-encoder';
import sharp from 'sharp';
import { homeDir } from './source.ts';

export type TextureCodec = 'etc1s' | 'uastc';
export type ColorSpace = 'srgb' | 'linear';
export type TextureRole =
  'baseColor' | 'normal' | 'metallicRoughness' | 'occlusionRoughnessMetal' | 'emissive';

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface TextureSpec {
  name: string;
  role: TextureRole;
  codec: TextureCodec;
  colorSpace: ColorSpace;
  image: Rgba;
}

export interface EncodedVariant {
  size: number;
  codec: TextureCodec;
  bytes: Uint8Array;
}

export const TIER_SIZES = { '1k': 1024, '2k': 2048 } as const;
export type Tier = keyof typeof TIER_SIZES;

/**
 * The '1k' slot is what low/medium tiers fetch and the '2k' slot what high/ultra fetch. Normal maps
 * are capped lower than colour because their payload is the bulk of the download budget
 * (PLAN section 2.7); the real edge length is recorded per variant in index.json.
 *
 * Codec split for normals: ETC1S cannot hold a normal's chroma across 4x4 block edges (1.9 to 3.6
 * times the in-block angular error), so the desktop slot is UASTC and only the small mobile slot
 * stays ETC1S.
 */
export const NORMAL_TIER_SIZES = { '1k': 512, '2k': 1024 } as const;

export function tierMaxDim(tier: Tier, role: TextureRole): number {
  return role === 'normal' ? NORMAL_TIER_SIZES[tier] : TIER_SIZES[tier];
}

export function tierCodec(codec: TextureCodec, role: TextureRole, tier: Tier): TextureCodec {
  return role === 'normal' && tier === '2k' ? 'uastc' : codec;
}

const ENCODER_VERSION = 'ktx2-encoder@0.6.0:etc1s-q128-c2:uastc-l1-zstd:v1';
const NORMAL_ENCODER_VERSION = 'normal:etc1s-q255-c2-normalmap:uastc-l1-normalmap:v3';

export function cacheDir(): string {
  const dir = join(homeDir(), '.cache', 'aquarium-assets', 'pipeline-cache');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function decodeImage(source: Uint8Array | Buffer): Promise<Rgba> {
  const { data, info } = await sharp(source)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  };
}

export function floorPow2(n: number): number {
  return 2 ** Math.floor(Math.log2(Math.max(4, n)));
}

/** Largest power-of-two dimensions that fit in `maxDim` without upscaling past the source. */
export function targetDimensions(
  width: number,
  height: number,
  maxDim: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxDim / Math.max(width, height));
  return {
    width: floorPow2(Math.round(width * scale)),
    height: floorPow2(Math.round(height * scale)),
  };
}

export async function resizeImage(image: Rgba, maxDim: number): Promise<Rgba> {
  const target = targetDimensions(image.width, image.height, maxDim);
  if (target.width === image.width && target.height === image.height) return image;
  const { data, info } = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .resize(target.width, target.height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  };
}

export async function cropImage(
  image: Rgba,
  rect: { left: number; top: number; width: number; height: number },
): Promise<Rgba> {
  const { data, info } = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .extract(rect)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  };
}

export function hasMeaningfulAlpha(image: Rgba, threshold = 250): boolean {
  let transparent = 0;
  for (let i = 3; i < image.data.length; i += 4)
    if ((image.data[i] ?? 255) < threshold) transparent++;
  return transparent / (image.data.length / 4) > 0.002;
}

function cacheKey(
  image: Rgba,
  spec: Pick<TextureSpec, 'codec' | 'colorSpace' | 'role'>,
  qualityLevel?: number,
): string {
  return createHash('sha256')
    .update(ENCODER_VERSION)
    .update(qualityLevel === undefined ? '' : `|q${qualityLevel}`)
    .update(`${spec.codec}|${spec.colorSpace}|${spec.role}|${image.width}x${image.height}|`)
    .update(spec.role === 'normal' ? NORMAL_ENCODER_VERSION : '')
    .update(image.data)
    .digest('hex');
}

const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const KTX2_HEADER_BYTES = 80;
const KTX2_LEVEL_INDEX_BYTES = 24;

/** True when the bytes carry the KTX2 identifier and every mip level they declare lies inside the file. */
export function isCompleteKtx2(bytes: Uint8Array): boolean {
  if (bytes.byteLength < KTX2_HEADER_BYTES) return false;
  if (KTX2_IDENTIFIER.some((byte, i) => bytes[i] !== byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const levels = Math.max(1, view.getUint32(40, true));
  const indexEnd = KTX2_HEADER_BYTES + levels * KTX2_LEVEL_INDEX_BYTES;
  if (bytes.byteLength < indexEnd) return false;
  for (let level = 0; level < levels; level++) {
    const at = KTX2_HEADER_BYTES + level * KTX2_LEVEL_INDEX_BYTES;
    const end = Number(view.getBigUint64(at, true) + view.getBigUint64(at + 8, true));
    if (end > bytes.byteLength) return false;
  }
  return true;
}

export interface Ktx2Info {
  width: number;
  height: number;
  levels: number;
  /** DFD colour model: 163 is ETC1S, 166 is UASTC. */
  colorModel: number;
  /** DFD transfer function: 1 linear, 2 sRGB. */
  transfer: number;
}

export function readKtx2Info(bytes: Uint8Array): Ktx2Info {
  if (!isCompleteKtx2(bytes)) throw new Error('not a complete KTX2 file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dfd = view.getUint32(48, true);
  return {
    width: view.getUint32(20, true),
    height: view.getUint32(24, true),
    levels: Math.max(1, view.getUint32(40, true)),
    colorModel: view.getUint8(dfd + 12),
    transfer: view.getUint8(dfd + 14),
  };
}

/** The `KTXmapRange` scale basisu stores when it had to rescale an HDR image; 1 when absent. three ignores it. */
export function ktx2MapRangeScale(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = view.getUint32(56, true);
  const end = at + view.getUint32(60, true);
  while (at + 4 <= end) {
    const length = view.getUint32(at, true);
    const entry = bytes.subarray(at + 4, at + 4 + length);
    const split = entry.indexOf(0);
    if (new TextDecoder().decode(entry.subarray(0, split)) === 'KTXmapRange') {
      return view.getFloat32(at + 4 + split + 1, true);
    }
    at += 4 + Math.ceil(length / 4) * 4;
  }
  return 1;
}

function readCachedKtx2(path: string): Uint8Array | null {
  if (!existsSync(path)) return null;
  const bytes = new Uint8Array(readFileSync(path));
  return isCompleteKtx2(bytes) ? bytes : null;
}

function writeCachedKtx2(path: string, bytes: Uint8Array): void {
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, bytes);
  renameSync(partial, path);
}

const HDR_ENCODER_VERSION = 'ktx2-encoder@0.6.0:uastc-hdr-q1-zstd-nomips:v1';

/** Encodes a Radiance .hdr (equirectangular) to a UASTC HDR 4x4 KTX2 that KTX2Loader transcodes to BC6H or RGBA16F. */
export async function encodeHdrKtx2(hdr: Uint8Array): Promise<Uint8Array> {
  const digest = createHash('sha256').update(HDR_ENCODER_VERSION).update(hdr).digest('hex');
  const path = join(cacheDir(), `${digest}.ktx2`);
  const cached = readCachedKtx2(path);
  if (cached && ktx2MapRangeScale(cached) === 1) return cached;
  const log = console.log;
  console.log = () => undefined;
  try {
    const bytes = await encodeToKTX2(new Uint8Array(hdr), {
      isHDR: true,
      imageType: 'hdr',
      isUASTC: true,
      isKTX2File: true,
      generateMipmap: false,
      needSupercompression: true,
      hdrQualityLevel: 1,
    });
    if (!isCompleteKtx2(bytes)) throw new Error('HDR KTX2 encoder returned an incomplete file');
    const scale = ktx2MapRangeScale(bytes);
    if (scale !== 1) {
      throw new Error(
        `HDR KTX2 carries KTXmapRange scale ${scale}, which three ignores and would darken the map; clamp the source to the half-float range first`,
      );
    }
    writeCachedKtx2(path, bytes);
    return bytes;
  } finally {
    console.log = log;
  }
}

/** `qualityLevel` (1 to 255) overrides the ETC1S quality of a non-normal texture. */
export async function encodeKtx2(
  image: Rgba,
  spec: Pick<TextureSpec, 'codec' | 'colorSpace' | 'role'>,
  qualityLevel?: number,
): Promise<Uint8Array> {
  const path = join(cacheDir(), `${cacheKey(image, spec, qualityLevel)}.ktx2`);
  const cached = readCachedKtx2(path);
  if (cached) return cached;
  const imageDecoder = async () => ({ width: image.width, height: image.height, data: image.data });
  const log = console.log;
  console.log = () => undefined;
  try {
    const bytes =
      spec.codec === 'uastc'
        ? await encodeToKTX2(new Uint8Array(1), {
            isUASTC: true,
            isNormalMap: spec.role === 'normal',
            isPerceptual: false,
            isSetKTX2SRGBTransferFunc: spec.colorSpace === 'srgb',
            generateMipmap: true,
            isKTX2File: true,
            needSupercompression: true,
            uastcLDRQualityLevel: 1,
            imageDecoder,
          })
        : await encodeToKTX2(new Uint8Array(1), {
            isUASTC: false,
            isNormalMap: spec.role === 'normal',
            qualityLevel: spec.role === 'normal' ? 255 : (qualityLevel ?? 128),
            compressionLevel: 2,
            isPerceptual: spec.colorSpace === 'srgb',
            isSetKTX2SRGBTransferFunc: spec.colorSpace === 'srgb',
            generateMipmap: true,
            isKTX2File: true,
            imageDecoder,
          });
    writeCachedKtx2(path, bytes);
    return bytes;
  } finally {
    console.log = log;
  }
}

export async function encodeTiers(spec: TextureSpec): Promise<Record<Tier, EncodedVariant>> {
  const out = {} as Record<Tier, EncodedVariant>;
  for (const tier of Object.keys(TIER_SIZES) as Tier[]) {
    const image = await resizeImage(spec.image, tierMaxDim(tier, spec.role));
    const codec = tierCodec(spec.codec, spec.role, tier);
    out[tier] = {
      size: Math.max(image.width, image.height),
      codec,
      bytes: await encodeKtx2(image, { ...spec, codec }),
    };
  }
  return out;
}
