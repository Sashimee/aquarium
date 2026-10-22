import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoaderUtils } from 'three';
import { BACKGROUND_IDS, type PlayableBiome } from '@aquarium/shared';
import { EventBus, type EngineEvents } from '../events';
import { backgroundFile, parseBackgroundFiles } from '../tank/background';
import { parseFishAssets } from '../../fish/assetIndex';
import { DEMO_STOCKS } from '../../fish/demoStock';
import {
  ASSET_BASE,
  AssetCatalog,
  type CatalogEntry,
  collapseDotSegments,
} from '../../scene/assets';
import { loadPreset } from '../../scene/preset';
import { DESKTOP_PROFILE, MOBILE_PROFILE, type QualityProfile } from './profile';
import { QualityManager } from './QualityManager';
import { TIERS, type Tier } from './tiers';

const PUBLIC_ASSETS = join(__dirname, '../../../public/assets');
const MIB = 2 ** 20;

const KHR_DF_MODEL_ETC1S = 163;
const KHR_DF_MODEL_UASTC = 166;

interface Ktx2Layout {
  readonly width: number;
  readonly height: number;
  readonly levels: number;
  readonly faces: number;
  readonly colorModel: number;
  readonly samples: number;
}

function ktx2Layout(bytes: Uint8Array, label: string): Ktx2Layout {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb];
  if (!magic.every((b, i) => bytes[i] === b)) throw new Error(`${label} is not a KTX2 file`);
  const dfd = view.getUint32(48, true);
  const blockSize = view.getUint16(dfd + 4 + 6, true);
  return {
    width: view.getUint32(20, true),
    height: Math.max(1, view.getUint32(24, true)),
    faces: view.getUint32(36, true),
    levels: Math.max(1, view.getUint32(40, true)),
    colorModel: view.getUint8(dfd + 4 + 8),
    samples: (blockSize - 24) / 16,
  };
}

/**
 * Bytes the GPU holds once KTX2Loader has transcoded the file, mips included. ETC1S without alpha
 * becomes ETC1/BC1 (8 bytes per 4x4 block); ETC1S with alpha and UASTC become ETC2, ASTC 4x4,
 * BC3 or BC7 (16 bytes per block). `rgba8` is the fallback for a device with no compressed format.
 */
function decodedBytes(layout: Ktx2Layout, decode: 'compressed' | 'rgba8', label: string): number {
  let blockBytes: number;
  if (layout.colorModel === KHR_DF_MODEL_ETC1S) blockBytes = layout.samples > 1 ? 16 : 8;
  else if (layout.colorModel === KHR_DF_MODEL_UASTC) blockBytes = 16;
  else throw new Error(`${label}: colour model ${layout.colorModel} is not a Basis texture`);
  let total = 0;
  for (let level = 0; level < layout.levels; level++) {
    const w = Math.max(1, layout.width >> level);
    const h = Math.max(1, layout.height >> level);
    total += decode === 'rgba8' ? w * h * 4 : Math.ceil(w / 4) * Math.ceil(h / 4) * blockBytes;
  }
  return total * layout.faces;
}

function readAsset(file: string): Uint8Array {
  return readFileSync(join(PUBLIC_ASSETS, file));
}

function glbImageUris(file: string): string[] {
  const glb = Buffer.from(readAsset(file));
  if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a binary glTF`);
  const length = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + length).toString('utf8')) as {
    images?: { uri?: string }[];
  };
  return (json.images ?? []).map((image, i) => {
    if (image.uri === undefined)
      throw new Error(`${file}: image ${i} is embedded, not a KTX2 file`);
    return image.uri;
  });
}

/** The map a GLB under `glb` requests for `uri`, relative to the assets root, before any swap. */
function resolvedMap(glb: string, uri: string): string {
  const url = LoaderUtils.resolveURL(uri, LoaderUtils.extractUrlBase(`${ASSET_BASE}${glb}`));
  return collapseDotSegments(url).slice(ASSET_BASE.length);
}

const indexJson: unknown = JSON.parse(readFileSync(join(PUBLIC_ASSETS, 'index.json'), 'utf8'));
const catalog = new AssetCatalog((indexJson as { assets: CatalogEntry[] }).assets);
const fishAssets = parseFishAssets(indexJson);
const backgrounds = parseBackgroundFiles(indexJson);
const BIOMES = Object.keys(BACKGROUND_IDS) as PlayableBiome[];

interface TextureUse {
  readonly owner: string;
  readonly file: string;
}

/**
 * Every texture the demo tank of `biome` holds at `tier`. A scene model is counted with the maps of
 * all its LODs, since a tier change loads the new LOD before freeing the old. Impostor atlases are
 * counted on every tier: they load the first time a tier wants them and stay, and phones start on
 * medium, which does. The room HDRI is left out: it is freed once drawn into the PMREM.
 */
function demoTextures(biome: PlayableBiome, tier: Tier, size: 1024 | 2048): TextureUse[] {
  const preset = loadPreset(biome);
  const uses: TextureUse[] = [];
  const models = new Set([
    ...preset.decor.map((d) => d.assetId),
    ...preset.plantPatches.map((p) => p.assetId),
  ]);
  for (const assetId of models) {
    if (!catalog.has(assetId)) continue;
    const maps = new Set<string>();
    for (const { file } of catalog.get(assetId).lods) {
      for (const uri of glbImageUris(file)) {
        const url = `${ASSET_BASE}${resolvedMap(file, uri)}`;
        maps.add(catalog.materialTextureUrl(url, size).slice(ASSET_BASE.length));
      }
    }
    for (const file of maps) uses.push({ owner: assetId, file });
  }
  const substrate = preset.substrate;
  for (const assetId of substrate ? [substrate.assetId, substrate.accentAssetId] : []) {
    if (assetId === undefined) continue;
    for (const role of ['baseColor', 'normal', 'occlusionRoughnessMetal']) {
      const file = catalog.textureFile(assetId, role, size);
      if (file === undefined) throw new Error(`substrate ${assetId} has no ${role} map`);
      uses.push({ owner: assetId, file });
    }
  }
  const species = new Set(Object.keys(DEMO_STOCKS[biome].counts));
  for (const entry of fishAssets.values()) {
    if (!species.has(entry.species)) continue;
    const maps = new Set<string>();
    for (const file of entry.lodFiles) {
      for (const uri of glbImageUris(file)) {
        const small = resolvedMap(file, uri);
        maps.add(size === 2048 ? (entry.sharperTextures.get(small) ?? small) : small);
      }
    }
    if (entry.impostor) maps.add(entry.impostor.albedoFile).add(entry.impostor.normalFile);
    for (const file of maps) uses.push({ owner: entry.id, file });
  }
  const largestBackdrop = BACKGROUND_IDS[biome]
    .map((id) => backgroundFile(backgrounds, id, tier))
    .map((file) => ({ file, bytes: decodedBytes(layoutOf(file), 'compressed', file) }))
    .sort((a, b) => b.bytes - a.bytes)[0];
  if (largestBackdrop) uses.push({ owner: 'background', file: largestBackdrop.file });
  return uses;
}

const layouts = new Map<string, Ktx2Layout>();
function layoutOf(file: string): Ktx2Layout {
  let layout = layouts.get(file);
  if (layout === undefined) {
    layout = ktx2Layout(readAsset(file), file);
    layouts.set(file, layout);
  }
  return layout;
}

function mib(uses: readonly TextureUse[], decode: 'compressed' | 'rgba8' = 'compressed'): number {
  const bytes = uses.reduce((sum, u) => sum + decodedBytes(layoutOf(u.file), decode, u.file), 0);
  return bytes / MIB;
}

function textureSizeOn(profile: QualityProfile, tier: Tier): 1024 | 2048 {
  return new QualityManager(new EventBus<EngineEvents>(), {
    gpuTiming: false,
    pinned: tier,
    adaptive: false,
    targetMs: profile.targetMs,
    maxTextureSize: profile.maxTextureSize,
  }).settings.textureSize;
}

describe('decodedBytes', () => {
  const layout = (colorModel: number, samples: number): Ktx2Layout => ({
    width: 8,
    height: 8,
    levels: 2,
    faces: 1,
    colorModel,
    samples,
  });

  it('counts 4x4 blocks over every mip level', () => {
    expect(decodedBytes(layout(KHR_DF_MODEL_ETC1S, 1), 'compressed', 'rgb')).toBe(5 * 8);
    expect(decodedBytes(layout(KHR_DF_MODEL_ETC1S, 2), 'compressed', 'rgba')).toBe(5 * 16);
    expect(decodedBytes(layout(KHR_DF_MODEL_UASTC, 1), 'compressed', 'uastc')).toBe(5 * 16);
  });

  it('counts four bytes a texel when nothing is transcoded to a compressed format', () => {
    expect(decodedBytes(layout(KHR_DF_MODEL_ETC1S, 1), 'rgba8', 'rgb')).toBe((64 + 16) * 4);
  });

  it('rounds a level smaller than a block up to one block', () => {
    const tiny = { ...layout(KHR_DF_MODEL_UASTC, 1), width: 2, height: 1, levels: 2 };
    expect(decodedBytes(tiny, 'compressed', 'tiny')).toBe(2 * 16);
  });

  it('rejects a texture that is not Basis', () => {
    expect(() => decodedBytes(layout(167, 1), 'compressed', 'hdri.ktx2')).toThrow(/hdri\.ktx2/);
  });

  it('reads the layout of a shipped KTX2 file', () => {
    const file = catalog.textureFile('boulder-01', 'baseColor', 1024);
    if (file === undefined) throw new Error('boulder-01 has no base colour map');
    expect(layoutOf(file)).toMatchObject({ width: 1024, height: 1024, levels: 11, faces: 1 });
  });
});

describe('texture memory budget of the demo tanks', () => {
  it.each(BIOMES)('finds the %s demo textures in the shipped assets', (biome) => {
    const uses = demoTextures(biome, 'medium', 1024);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.some((u) => u.owner === 'background')).toBe(true);
  });

  for (const [name, profile] of [
    ['phone', MOBILE_PROFILE],
    ['desktop', DESKTOP_PROFILE],
  ] as const) {
    for (const tier of TIERS) {
      it.each(BIOMES)(`keeps the %s demo on a ${name} at ${tier} within budget`, (biome) => {
        const used = mib(demoTextures(biome, tier, textureSizeOn(profile, tier)));
        expect(used).toBeLessThanOrEqual(profile.textureBudgetMiB[tier]);
      });
    }
  }

  it('never gives a phone 2k maps, which nearly treble the freshwater demo', () => {
    for (const tier of TIERS) expect(textureSizeOn(MOBILE_PROFILE, tier)).toBe(1024);
    const phone = mib(demoTextures('freshwater', 'high', 1024));
    const desktop = mib(demoTextures('freshwater', 'high', 2048));
    expect(desktop).toBeGreaterThan(2 * phone);
    expect(desktop).toBeGreaterThan(MOBILE_PROFILE.textureBudgetMiB.high);
  });
});
