import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function cacheKey(image: Rgba, spec: Pick<TextureSpec, 'codec' | 'colorSpace' | 'role'>): string {
  return createHash('sha256')
    .update(ENCODER_VERSION)
    .update(`${spec.codec}|${spec.colorSpace}|${spec.role}|${image.width}x${image.height}|`)
    .update(spec.role === 'normal' ? NORMAL_ENCODER_VERSION : '')
    .update(image.data)
    .digest('hex');
}

async function encodeKtx2(
  image: Rgba,
  spec: Pick<TextureSpec, 'codec' | 'colorSpace' | 'role'>,
): Promise<Uint8Array> {
  const path = join(cacheDir(), `${cacheKey(image, spec)}.ktx2`);
  if (existsSync(path)) return new Uint8Array(readFileSync(path));
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
            qualityLevel: spec.role === 'normal' ? 255 : 128,
            compressionLevel: 2,
            isPerceptual: spec.colorSpace === 'srgb',
            isSetKTX2SRGBTransferFunc: spec.colorSpace === 'srgb',
            generateMipmap: true,
            isKTX2File: true,
            imageDecoder,
          });
    writeFileSync(path, bytes);
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
