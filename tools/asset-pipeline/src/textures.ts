import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeToKTX2 } from 'ktx2-encoder';
import sharp from 'sharp';

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
  bytes: Uint8Array;
}

export const TIER_SIZES = { '1k': 1024, '2k': 2048 } as const;
export type Tier = keyof typeof TIER_SIZES;

const ENCODER_VERSION = 'ktx2-encoder@0.6.0:etc1s-q128-c2:uastc-l1-zstd:v1';

export function cacheDir(): string {
  const dir = join(process.env['HOME'] ?? '', '.cache', 'aquarium-assets', 'pipeline-cache');
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
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i]! < threshold) transparent++;
  return transparent / (image.data.length / 4) > 0.002;
}

function cacheKey(image: Rgba, spec: Pick<TextureSpec, 'codec' | 'colorSpace' | 'role'>): string {
  return createHash('sha256')
    .update(ENCODER_VERSION)
    .update(`${spec.codec}|${spec.colorSpace}|${spec.role}|${image.width}x${image.height}|`)
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
            qualityLevel: 128,
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
    const image = await resizeImage(spec.image, TIER_SIZES[tier]);
    out[tier] = { size: Math.max(image.width, image.height), bytes: await encodeKtx2(image, spec) };
  }
  return out;
}
