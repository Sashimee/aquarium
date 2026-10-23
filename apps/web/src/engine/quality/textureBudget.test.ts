import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoaderUtils } from 'three';
import { BACKGROUND_IDS, speciesSchema, type PlayableBiome } from '@aquarium/shared';
import { EventBus, type EngineEvents } from '../events';
import { backgroundFile, parseBackgroundFiles, posterTier } from '../tank/background';
import { parseFishAssets } from '../../fish/assetIndex';
import { fishTextureSize } from '../../fish/assets';
import { droppedNormalLevels } from '../../fish/impostor';
import { DEMO_STOCKS } from '../../fish/demoStock';
import {
  ASSET_BASE,
  AssetCatalog,
  type CatalogEntry,
  collapseDotSegments,
} from '../../scene/assets';
import { euphylliaId, parseEuphylliaId } from '../../scene/euphyllia';
import { isMudBankId } from '../../scene/mudBank';
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
 * What KTX2Loader transcodes Basis to. `etc`: a phone, which has ETC2 or ASTC, so ETC1S without
 * alpha becomes ETC1 at 8 bytes per 4x4 block and everything else takes 16. `bc`: a desktop
 * without ETC2 (Windows and Linux), where the loader ranks BC7 above BC1 for ETC1S too, so every
 * block takes 16 bytes. `rgba8`: a device with no compressed format at all.
 */
type DecodeTarget = 'etc' | 'bc' | 'rgba8';

/**
 * Bytes the GPU holds once KTX2Loader has transcoded the file, mips included, less the
 * `dropped` top levels the engine does not upload.
 */
function decodedBytes(
  layout: Ktx2Layout,
  target: DecodeTarget,
  label: string,
  dropped = 0,
): number {
  let blockBytes: number;
  if (layout.colorModel === KHR_DF_MODEL_ETC1S)
    blockBytes = target === 'etc' && layout.samples === 1 ? 8 : 16;
  else if (layout.colorModel === KHR_DF_MODEL_UASTC) blockBytes = 16;
  else throw new Error(`${label}: colour model ${layout.colorModel} is not a Basis texture`);
  let total = 0;
  if (dropped >= layout.levels)
    throw new Error(`${label}: cannot drop ${dropped} of ${layout.levels} levels`);
  for (let level = dropped; level < layout.levels; level++) {
    const w = Math.max(1, layout.width >> level);
    const h = Math.max(1, layout.height >> level);
    total += target === 'rgba8' ? w * h * 4 : Math.ceil(w / 4) * Math.ceil(h / 4) * blockBytes;
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
  readonly droppedLevels?: number;
}

/**
 * The preset ids that load a model from the catalog. Procedural euphyllia is built in code and
 * holds no textures, and the procedural mud bank wears the substrate set counted separately; any other id the catalog lacks is a broken preset, not one to skip.
 */
function catalogModels(owner: string, assetIds: readonly string[]): Set<string> {
  const models = new Set<string>();
  for (const assetId of assetIds) {
    if (parseEuphylliaId(assetId) || isMudBankId(assetId)) continue;
    if (!catalog.has(assetId))
      throw new Error(`${owner} uses ${assetId}, which is not in the catalog`);
    models.add(assetId);
  }
  return models;
}

const contentSpecies = import.meta.glob<unknown>('../../../../../content/species/*.json', {
  eager: true,
  import: 'default',
});

/**
 * Every species content has for `biome`. Textures load per stocked species, and the animal cap
 * limits counts, not species, so one of each is the most a player's tank of the biome can hold.
 */
function fullRoster(biome: PlayableBiome): Set<string> {
  const species = Object.values(contentSpecies).map((raw) =>
    speciesSchema.partial({ render: true }).parse(raw),
  );
  return new Set(species.filter((s) => s.biome === biome).map((s) => s.id));
}

function demoTextures(
  biome: PlayableBiome,
  tier: Tier,
  size: 1024 | 2048,
  target: DecodeTarget,
): TextureUse[] {
  return tankTextures(biome, new Set(Object.keys(DEMO_STOCKS[biome].counts)), tier, size, target);
}

/**
 * Every texture a `biome` tank stocked with `species` holds at `tier`, with its preset's decor. A
 * scene model is counted with the maps of all its LODs, since a tier change loads the new LOD
 * before freeing the old. Impostor atlases are counted on every tier: they load the first time a
 * tier wants them and stay, and phones start on medium, which does. The room HDRI is left out: it
 * is freed once drawn into the PMREM.
 */
function tankTextures(
  biome: PlayableBiome,
  species: ReadonlySet<string>,
  tier: Tier,
  size: 1024 | 2048,
  target: DecodeTarget,
): TextureUse[] {
  const preset = loadPreset(biome);
  const uses: TextureUse[] = [];
  const models = catalogModels(biome, [
    ...preset.decor.map((d) => d.assetId),
    ...preset.plantPatches.map((p) => p.assetId),
  ]);
  for (const assetId of models) {
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
  for (const entry of fishAssets.values()) {
    if (!species.has(entry.species)) continue;
    const maps = new Set<string>();
    const fishSize = fishTextureSize(entry, size);
    for (const file of entry.lodFiles) {
      for (const uri of glbImageUris(file)) {
        const small = resolvedMap(file, uri);
        maps.add(fishSize === 2048 ? (entry.sharperTextures.get(small) ?? small) : small);
      }
    }
    for (const file of maps) uses.push({ owner: entry.id, file });
    const { impostor } = entry;
    if (impostor) {
      uses.push({ owner: entry.id, file: impostor.albedoFile });
      uses.push({
        owner: entry.id,
        file: impostor.normalFile,
        droppedLevels: droppedNormalLevels(impostor.frameSize),
      });
    }
  }
  const largestBackdrop = BACKGROUND_IDS[biome]
    .map((id) => backgroundFile(backgrounds, id, posterTier(tier, size)))
    .map((file) => ({ file, bytes: decodedBytes(layoutOf(file), target, file) }))
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

function mib(uses: readonly TextureUse[], target: DecodeTarget): number {
  const bytes = uses.reduce(
    (sum, u) => sum + decodedBytes(layoutOf(u.file), target, u.file, u.droppedLevels),
    0,
  );
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
    expect(decodedBytes(layout(KHR_DF_MODEL_ETC1S, 1), 'etc', 'rgb')).toBe(5 * 8);
    expect(decodedBytes(layout(KHR_DF_MODEL_ETC1S, 2), 'etc', 'rgba')).toBe(5 * 16);
    expect(decodedBytes(layout(KHR_DF_MODEL_UASTC, 1), 'etc', 'uastc')).toBe(5 * 16);
  });

  it('counts 16 bytes a block for ETC1S on a desktop that transcodes it to BC7', () => {
    expect(decodedBytes(layout(KHR_DF_MODEL_ETC1S, 1), 'bc', 'rgb')).toBe(5 * 16);
    expect(decodedBytes(layout(KHR_DF_MODEL_ETC1S, 2), 'bc', 'rgba')).toBe(5 * 16);
    expect(decodedBytes(layout(KHR_DF_MODEL_UASTC, 1), 'bc', 'uastc')).toBe(5 * 16);
  });

  it('counts four bytes a texel when nothing is transcoded to a compressed format', () => {
    expect(decodedBytes(layout(KHR_DF_MODEL_ETC1S, 1), 'rgba8', 'rgb')).toBe((64 + 16) * 4);
  });

  it('leaves out the top levels the engine does not upload', () => {
    expect(decodedBytes(layout(KHR_DF_MODEL_UASTC, 1), 'bc', 'normal', 1)).toBe(16);
    expect(() => decodedBytes(layout(KHR_DF_MODEL_UASTC, 1), 'bc', 'normal', 2)).toThrow(/normal/);
  });

  it('rounds a level smaller than a block up to one block', () => {
    const tiny = { ...layout(KHR_DF_MODEL_UASTC, 1), width: 2, height: 1, levels: 2 };
    expect(decodedBytes(tiny, 'etc', 'tiny')).toBe(2 * 16);
  });

  it('rejects a texture that is not Basis', () => {
    expect(() => decodedBytes(layout(167, 1), 'bc', 'hdri.ktx2')).toThrow(/hdri\.ktx2/);
  });

  it('reads the layout of a shipped KTX2 file', () => {
    const file = catalog.textureFile('boulder-01', 'baseColor', 1024);
    if (file === undefined) throw new Error('boulder-01 has no base colour map');
    expect(layoutOf(file)).toMatchObject({ width: 1024, height: 1024, levels: 11, faces: 1 });
  });
});

describe('catalogModels', () => {
  it('passes procedural euphyllia over and keeps catalog models', () => {
    const models = catalogModels('test', [euphylliaId('hammer', 3), 'boulder-01', 'boulder-01']);
    expect([...models]).toEqual(['boulder-01']);
  });

  it('fails on an id the catalog does not have', () => {
    expect(() => catalogModels('test', ['no-such-rock'])).toThrow(/no-such-rock/);
  });
});

describe('texture memory budget of the demo tanks', () => {
  it.each(BIOMES)('finds the %s demo textures in the shipped assets', (biome) => {
    const uses = demoTextures(biome, 'medium', 1024, 'bc');
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.some((u) => u.owner === 'background')).toBe(true);
  });

  for (const [name, profile, target] of [
    ['phone', MOBILE_PROFILE, 'etc'],
    ['desktop', DESKTOP_PROFILE, 'bc'],
  ] as const) {
    for (const tier of TIERS) {
      it.each(BIOMES)(`keeps the %s demo on a ${name} at ${tier} within budget`, (biome) => {
        const used = mib(demoTextures(biome, tier, textureSizeOn(profile, tier), target), target);
        expect(used).toBeLessThanOrEqual(profile.textureBudgetMiB[tier]);
      });
    }
  }

  it('never gives a phone 2k maps, which nearly treble the freshwater demo', () => {
    for (const tier of TIERS) expect(textureSizeOn(MOBILE_PROFILE, tier)).toBe(1024);
    const phone = mib(demoTextures('freshwater', 'high', 1024, 'etc'), 'etc');
    const desktop = mib(demoTextures('freshwater', 'high', 2048, 'etc'), 'etc');
    expect(desktop).toBeGreaterThan(2 * phone);
    expect(desktop).toBeGreaterThan(MOBILE_PROFILE.textureBudgetMiB.high);
  });

  it("counts a phone on high with medium's 1024x512 poster, not high's 2048x1024 one", () => {
    const poster = demoTextures('freshwater', 'high', textureSizeOn(MOBILE_PROFILE, 'high'), 'etc')
      .filter((u) => u.owner === 'background')
      .map((u) => layoutOf(u.file).width);
    expect(poster).toEqual([1024]);
  });
});

describe('texture memory budget of a tank holding every species of its biome', () => {
  it.each(BIOMES)('finds every %s species in the shipped fish assets', (biome) => {
    const roster = fullRoster(biome);
    for (const id of Object.keys(DEMO_STOCKS[biome].counts)) expect(roster.has(id), id).toBe(true);
    const shipped = new Set([...fishAssets.values()].map((e) => e.species));
    for (const id of roster) expect(shipped.has(id), id).toBe(true);
  });

  for (const [name, profile, target] of [
    ['phone', MOBILE_PROFILE, 'etc'],
    ['desktop', DESKTOP_PROFILE, 'bc'],
  ] as const) {
    for (const tier of TIERS) {
      it.each(BIOMES)(`keeps every %s species on a ${name} at ${tier} within budget`, (biome) => {
        const size = textureSizeOn(profile, tier);
        const used = mib(tankTextures(biome, fullRoster(biome), tier, size, target), target);
        expect(used).toBeLessThanOrEqual(profile.textureBudgetMiB[tier]);
      });
    }
  }
});
