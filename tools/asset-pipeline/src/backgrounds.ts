import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BACKGROUND_IDS,
  BACKGROUND_MAX_BYTES,
  BACKGROUND_TIERS,
  backgroundFileSchema,
  type BackgroundTier,
} from '@aquarium/shared';
import sharp from 'sharp';
import type { FishContext } from './fish.ts';
import { writeFileTracked } from './glb.ts';
import type { OutputAsset } from './index-schema.ts';
import { MISTY_LAKE_ID } from './misty-lake.ts';
import type { ManifestAsset } from './manifest.ts';
import { RAW_ROOT } from './source.ts';
import { encodeKtx2, readKtx2Info, type Rgba } from './textures.ts';

export const BACKGROUND_KIND = 'background';
export const BACKGROUND_TIER_NAMES = Object.keys(BACKGROUND_TIERS) as BackgroundTier[];
export const BACKGROUND_MIN_CROP_WIDTH = BACKGROUND_TIERS.high[0];
/** ETC1S quality levels tried from best to worst until the file fits the budget. */
export const QUALITY_LADDER = [192, 160, 128, 96, 64, 40, 24] as const;
const ETC1S_COLOR_MODEL = 163;
const TRANSFER_SRGB = 2;
/** The only key/value entry a shipped background may carry; EXIF, XMP and GPS never survive the raw-pixel route. */
const ALLOWED_KTX2_KEYS: readonly string[] = ['KTXwriter'];

export interface CropBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function cropProblems(crop: CropBox, source: { width: number; height: number }): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(crop)) {
    if (!Number.isInteger(value) || value < 0)
      problems.push(`crop.${name} must be an integer >= 0`);
  }
  if (problems.length > 0) return problems;
  if (crop.width !== 2 * crop.height) {
    problems.push(`crop ${crop.width}x${crop.height} is not 2:1`);
  }
  if (crop.width < BACKGROUND_MIN_CROP_WIDTH) {
    problems.push(
      `crop is ${crop.width} px wide, under the ${BACKGROUND_MIN_CROP_WIDTH} px the high tier needs`,
    );
  }
  if (crop.left + crop.width > source.width || crop.top + crop.height > source.height) {
    problems.push(
      `crop ${crop.width}x${crop.height} at ${crop.left},${crop.top} does not fit the ${source.width}x${source.height} source`,
    );
  }
  return problems;
}

export interface Encoded {
  bytes: Uint8Array;
  qualityLevel: number;
}

/** The best-quality encoding at or under `maxBytes`; throws when even the lowest quality is over. */
export async function encodeWithinBudget(
  encode: (qualityLevel: number) => Promise<Uint8Array>,
  maxBytes: number,
  ladder: readonly number[] = QUALITY_LADDER,
): Promise<Encoded> {
  let smallest = Infinity;
  for (const qualityLevel of ladder) {
    const bytes = await encode(qualityLevel);
    if (bytes.byteLength <= maxBytes) return { bytes, qualityLevel };
    smallest = Math.min(smallest, bytes.byteLength);
  }
  throw new Error(
    `even ETC1S quality ${ladder.at(-1)} is ${smallest} bytes, over the ${maxBytes} byte budget; pick a smoother source or crop`,
  );
}

export interface TierImages {
  crop: CropBox;
  tiers: Record<BackgroundTier, Rgba>;
}

/** Applies the EXIF orientation, crops, converts to sRGB and resizes per tier; the output is raw pixels, so no metadata is carried. */
export async function deriveTierImages(source: Buffer, crop: CropBox | null): Promise<TierImages> {
  const oriented = await sharp(source, { limitInputPixels: 200_000_000 })
    .rotate()
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = oriented.info;
  const box = crop ?? { left: 0, top: 0, width, height };
  const problems = cropProblems(box, { width, height });
  if (problems.length > 0) throw new Error(problems.join('; '));
  const cropped = await sharp(oriented.data, { raw: { width, height, channels: 3 } })
    .extract(box)
    .raw()
    .toBuffer();
  const tiers = {} as Record<BackgroundTier, Rgba>;
  for (const tier of BACKGROUND_TIER_NAMES) {
    const [w, h] = BACKGROUND_TIERS[tier];
    const data = await sharp(cropped, {
      raw: { width: box.width, height: box.height, channels: 3 },
    })
      .resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
      .ensureAlpha()
      .raw()
      .toBuffer();
    tiers[tier] = {
      width: w,
      height: h,
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    };
  }
  return { crop: box, tiers };
}

export function ktx2KeyValueKeys(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = view.getUint32(56, true);
  const end = at + view.getUint32(60, true);
  const keys: string[] = [];
  while (at + 4 <= end) {
    const length = view.getUint32(at, true);
    const entry = bytes.subarray(at + 4, at + 4 + length);
    const split = entry.indexOf(0);
    keys.push(new TextDecoder().decode(entry.subarray(0, split < 0 ? entry.length : split)));
    at += 4 + Math.ceil(length / 4) * 4;
  }
  return keys;
}

/** Tiers that ship another tier's file instead of a byte-identical copy of their own. */
export const BACKGROUND_TIER_ALIAS: Partial<Record<BackgroundTier, BackgroundTier>> = {
  ultra: 'high',
};

export function backgroundFile(id: string, tier: BackgroundTier): string {
  return `${BACKGROUND_KIND}/${id}/${BACKGROUND_TIER_ALIAS[tier] ?? tier}.ktx2`;
}

const RENDER_INPUTS: Record<string, string> = {
  'bg-cichlid-tanganyika-shell-bed': 'CC0 rocks and a CC0 ground texture and a CC-BY shell model',
  'bg-blackwater-root-tangle':
    'a driftwood root scan (HeartOfLines, CC-BY-4.0) with CC0 trunk, twig and leaf-litter assets',
  'bg-blackwater-driftwood-wall':
    'a driftwood scan (jasonwebb, CC-BY-4.0) with CC0 twig and leaf-litter assets',
  'bg-mangrove-prop-root-thicket':
    'mangrove prop roots (lucq22, CC-BY-4.0) with a CC0 red mangrove scan and a CC0 mud texture',
  'bg-mangrove-petrified-stump':
    'a petrified mangrove stump scan (JFN / db4, CC-BY-4.0) and mangrove prop roots (lucq22, CC-BY-4.0) with CC0 rocks and a CC0 mud texture',
  'bg-mangrove-tidal-flat':
    'a CC0 red mangrove scan, a CC0 propagule scan and CC0 mud and sand textures',
  'bg-mangrove-open-water': 'a CC0 red mangrove scan and a CC0 mud texture',
};

const RENDER_INPUTS_BY_BIOME: Record<string, string> = {
  cichlid: 'CC0 rocks and a CC0 ground texture',
  blackwater: 'CC0 twigs, trunks and leaf-litter textures',
  mangrove: 'a CC0 red mangrove scan, CC0 rocks and CC0 mud and sand textures',
};

function renderInputs(entry: ManifestAsset): string {
  return (
    RENDER_INPUTS[entry.id] ??
    (typeof entry['biome'] === 'string' ? RENDER_INPUTS_BY_BIOME[entry['biome']] : undefined) ??
    `the ${entry.licence} source assets credited for this background`
  );
}

export function backgroundModifications(entry: ManifestAsset, crop: CropBox | null): string[] {
  const resized =
    'resized to 2048x1024, 1024x512 and 512x256 with a Lanczos filter, one file per quality tier';
  const encoded = 're-encoded as KTX2 (Basis ETC1S, sRGB, with mipmaps)';
  const stripped = 'all EXIF, XMP, GPS and other metadata removed';
  if (entry.id === MISTY_LAKE_ID) {
    return [
      'composed and rendered by the Aquarium project from Java fern and vallisneria (Nullified), pond weed (Valery.Li), driftwood, rocks and ground textures (CC0), at 4096x2048 with depth-of-field blur, then graded underwater (colour absorption, depth haze, god rays, vignette and film grain)',
      resized,
      encoded,
      stripped,
    ];
  }
  if (isRenderEntry(entry)) {
    return [
      `composed and rendered by the Aquarium project from ${renderInputs(entry)} with a software rasteriser at 4096x2048, then depth-of-field blurred and graded underwater (colour absorption, depth haze, god rays, vignette and film grain)`,
      resized,
      encoded,
      stripped,
    ];
  }
  if (!crop) throw new Error(`${entry.id}: a photo background needs a crop box in the manifest`);
  return [
    `cropped to the 2:1 box left ${crop.left}, top ${crop.top}, ${crop.width}x${crop.height} px of the original photo`,
    resized,
    encoded,
    stripped,
  ];
}

export function isRenderEntry(entry: ManifestAsset): boolean {
  return (entry as Record<string, unknown>)['source'] === 'render';
}

function cropOf(entry: ManifestAsset): CropBox | null {
  const raw = (entry as Record<string, unknown>)['crop'];
  if (raw === undefined || raw === null) return null;
  const box = raw as Partial<CropBox>;
  if (
    typeof box.left !== 'number' ||
    typeof box.top !== 'number' ||
    typeof box.width !== 'number' ||
    typeof box.height !== 'number'
  ) {
    throw new Error(`${entry.id}: manifest crop must be {left, top, width, height}`);
  }
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}

export interface BuiltBackground {
  asset: OutputAsset;
  preview: Rgba;
}

export async function buildBackground(
  entry: ManifestAsset,
  ctx: FishContext,
): Promise<BuiltBackground> {
  ctx.verifySource(entry.id);
  const isRender = isRenderEntry(entry);
  const path = join(RAW_ROOT, entry.id, isRender ? 'render.png' : 'original.jpg');
  if (!existsSync(path)) throw new Error(`${entry.id}: ${path} is missing`);
  const crop = isRender ? null : cropOf(entry);
  const images = await deriveTierImages(readFileSync(path), crop);

  const files = [];
  const tiers = {} as Record<
    BackgroundTier,
    {
      file: string;
      width: number;
      height: number;
      bytes: number;
      sha256: string;
      qualityLevel: number;
    }
  >;
  for (const tier of BACKGROUND_TIER_NAMES) {
    if (BACKGROUND_TIER_ALIAS[tier]) continue;
    const image = images.tiers[tier];
    const encoded = await encodeWithinBudget(
      (q) => encodeKtx2(image, { codec: 'etc1s', colorSpace: 'srgb', role: 'baseColor' }, q),
      BACKGROUND_MAX_BYTES,
    );
    const written = writeFileTracked(ctx.outRoot, backgroundFile(entry.id, tier), encoded.bytes);
    files.push(written);
    tiers[tier] = {
      ...written,
      width: image.width,
      height: image.height,
      qualityLevel: encoded.qualityLevel,
    };
  }
  for (const tier of BACKGROUND_TIER_NAMES) {
    const target = BACKGROUND_TIER_ALIAS[tier];
    if (target) tiers[tier] = tiers[target];
  }
  const asset: OutputAsset = {
    id: entry.id,
    kind: BACKGROUND_KIND,
    origin: isRender ? 'render' : 'photo',
    sources: [entry.id],
    licence: ctx.licenceOf(entry.id),
    modifications: backgroundModifications(entry, crop),
    lods: [],
    textures: [],
    files,
    background: {
      crop: isRender ? null : images.crop,
      tiers: {
        ultra: tiers.ultra,
        high: tiers.high,
        medium: tiers.medium,
        low: tiers.low,
      },
    },
  };
  return { asset, preview: images.tiers.low };
}

export async function contactSheet(previews: { id: string; image: Rgba }[]): Promise<Buffer> {
  const columns = 2;
  const cell = { width: 512, height: 256 };
  const rows = Math.ceil(previews.length / columns);
  const sheet = sharp({
    create: {
      width: columns * cell.width,
      height: rows * cell.height,
      channels: 3,
      background: '#101418',
    },
  });
  const inputs = await Promise.all(
    previews.map(async ({ image }, i) => ({
      input: await sharp(image.data, {
        raw: { width: image.width, height: image.height, channels: 4 },
      })
        .removeAlpha()
        .resize(cell.width, cell.height)
        .png()
        .toBuffer(),
      left: (i % columns) * cell.width,
      top: Math.floor(i / columns) * cell.height,
    })),
  );
  return sheet.composite(inputs).png({ compressionLevel: 9 }).toBuffer();
}

/** Points each `content/backgrounds/<biome>.json` entry at its high-tier file; returns the files it changed. */
export function syncContentFiles(repoRoot: string, builtIds: ReadonlySet<string>): string[] {
  const changed: string[] = [];
  for (const biome of Object.keys(BACKGROUND_IDS) as (keyof typeof BACKGROUND_IDS)[]) {
    const path = join(repoRoot, 'content', 'backgrounds', `${biome}.json`);
    const original = readFileSync(path, 'utf8');
    const entries = backgroundFileSchema.parse(JSON.parse(original));
    let dirty = false;
    for (const entry of entries) {
      if (entry.asset !== null && builtIds.has(entry.asset)) {
        const file = backgroundFile(entry.asset, 'high');
        if (entry.file !== file) {
          entry.file = file;
          dirty = true;
        }
      }
    }
    if (dirty) {
      writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`);
      changed.push(path);
    }
  }
  return changed;
}

export function backgroundFileProblems(
  asset: OutputAsset,
  readFile: (relative: string) => Uint8Array | null,
): string[] {
  const at = `background ${asset.id}`;
  const problems: string[] = [];
  if (!asset.background) return [`${at}: index entry has no background block (crop, tiers)`];
  for (const tier of BACKGROUND_TIER_NAMES) {
    const entry = asset.background.tiers[tier];
    const [width, height] = BACKGROUND_TIERS[tier];
    const expected = backgroundFile(asset.id, tier);
    if (entry.file !== expected) problems.push(`${at}: ${tier} tier must be ${expected}`);
    if (entry.bytes > BACKGROUND_MAX_BYTES) {
      problems.push(
        `${at}: ${entry.file} is ${entry.bytes} bytes, over the ${BACKGROUND_MAX_BYTES} byte background budget`,
      );
    }
    const bytes = readFile(entry.file);
    if (!bytes) continue;
    try {
      const info = readKtx2Info(bytes);
      if (info.width !== width || info.height !== height) {
        problems.push(
          `${at}: ${entry.file} is ${info.width}x${info.height}, ${tier} tier is ${width}x${height}`,
        );
      }
      if (info.colorModel !== ETC1S_COLOR_MODEL || info.transfer !== TRANSFER_SRGB) {
        problems.push(`${at}: ${entry.file} must be ETC1S with the sRGB transfer function`);
      }
      const extra = ktx2KeyValueKeys(bytes).filter((k) => !ALLOWED_KTX2_KEYS.includes(k));
      if (extra.length > 0) {
        problems.push(
          `${at}: ${entry.file} carries metadata entries (${extra.join(', ')}); strip them`,
        );
      }
    } catch (error) {
      problems.push(`${at}: ${entry.file} is unreadable: ${(error as Error).message}`);
    }
  }
  return problems;
}

export interface ContentBackground {
  id: string;
  file: string | null;
  asset: string | null;
}

export function backgroundContentProblems(
  entries: readonly ContentBackground[],
  built: ReadonlyMap<string, OutputAsset>,
): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    if (entry.asset === null) continue;
    const expected = backgroundFile(entry.asset, 'high');
    if (!built.has(entry.asset)) {
      problems.push(
        `content/backgrounds ${entry.id}: asset "${entry.asset}" is not built into index.json`,
      );
    } else if (entry.file !== expected) {
      problems.push(
        `content/backgrounds ${entry.id}: file is ${entry.file === null ? 'null' : `"${entry.file}"`}, expected "${expected}" (run pnpm build:assets)`,
      );
    }
  }
  return problems;
}

export function missingBackgroundProblems(
  manifestAssets: readonly ManifestAsset[],
  built: ReadonlyMap<string, OutputAsset>,
): string[] {
  return manifestAssets
    .filter((a) => a.kind === BACKGROUND_KIND && a.status === 'downloaded' && !built.has(a.id))
    .map(
      (a) =>
        `manifest asset ${a.id}: background is downloaded but not built into index.json (run pnpm build:assets)`,
    );
}
