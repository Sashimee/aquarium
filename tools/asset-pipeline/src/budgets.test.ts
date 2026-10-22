import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODE_RESERVE_BYTES,
  parseHdriUrl,
  TIER_BUDGETS,
  budgetProblems,
  loadBudgetContent,
  presetDownloadBytes,
  type BudgetInput,
} from './budgets.ts';
import type { AssetIndex, OutputAsset } from './index-schema.ts';

const HDRI = { id: 'studio-small-09', file: 'hdri/studio-small-09/env.hdr' };
const DIGEST = 'b'.repeat(64);

function entry(file: string, bytes: number) {
  return { file, bytes, sha256: DIGEST };
}

function variant(file: string, bytes: number, codec: 'etc1s' | 'uastc') {
  return { ...entry(file, bytes), size: 1024, codec };
}

function textured(id: string, kind: OutputAsset['kind'], low: number, high: number): OutputAsset {
  const lod = { ...entry(`${kind}/${id}/lod0.glb`, 1000), triangles: 10, vertices: 10 };
  const lod2 = { ...entry(`${kind}/${id}/lod2.glb`, 200), triangles: 2, vertices: 2 };
  const lod1 = { ...entry(`${kind}/${id}/lod1.glb`, 500), triangles: 5, vertices: 5 };
  const lowFile = `${kind}/${id}/textures/${id}_normal_1k.ktx2`;
  const highFile = `${kind}/${id}/textures/${id}_normal_2k.ktx2`;
  return {
    id,
    kind,
    origin: 'model',
    sources: [],
    licence: 'CC0-1.0',
    modifications: [],
    lods: [lod, lod1, lod2],
    textures: [
      {
        name: `${id}_normal`,
        role: 'normal',
        colorSpace: 'linear',
        variants: { '1k': variant(lowFile, low, 'etc1s'), '2k': variant(highFile, high, 'uastc') },
      },
    ],
    files: [lod, lod1, lod2, entry(lowFile, low), entry(highFile, high)].map(
      ({ file, bytes, sha256 }) => ({ file, bytes, sha256 }),
    ),
  };
}

function hdri(bytes: number): OutputAsset {
  const file = entry(HDRI.file, bytes);
  return {
    id: HDRI.id,
    kind: 'hdri',
    origin: 'passthrough',
    sources: [],
    licence: 'CC0-1.0',
    modifications: [],
    lods: [],
    textures: [],
    files: [file],
  };
}

function inputOf(assets: OutputAsset[]): BudgetInput {
  const index: AssetIndex = {
    version: 1,
    textureVariants: '',
    customAttributes: '',
    totalBytes: 0,
    assets,
  };
  return {
    index,
    hdri: HDRI,
    presets: [{ id: 'tank', biome: 'freshwater', assetIds: ['rock'] }],
    speciesBiome: new Map([
      ['tetra', 'freshwater'],
      ['tang', 'reef'],
    ]),
  };
}

function pileOf(id: string, member: OutputAsset): OutputAsset {
  const own = textured(id, 'rock', 0, 0);
  const [texture] = member.textures;
  const lods = own.lods.map((l) => ({ ...l, bytes: l.bytes + 7 }));
  return {
    ...own,
    lods,
    textures: texture ? [texture] : [],
    files: lods.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })),
  };
}

describe('presetDownloadBytes', () => {
  it('counts a texture borrowed from a member rock once when both are in the preset', () => {
    const rock = textured('rock', 'rock', 300, 9000);
    const pile = pileOf('pile', rock);
    const input = inputOf([hdri(2000), rock, pile]);
    input.presets = [{ id: 'tank', biome: 'freshwater', assetIds: ['rock', 'pile'] }];
    expect(presetDownloadBytes(input, input.presets[0]!, 'mobile')).toBe(
      2000 + (1000 + 200 + 300) + (1007 + 207),
    );
    expect(presetDownloadBytes(input, input.presets[0]!, 'desktop')).toBe(
      2000 + (1000 + 200 + 300 + 9000) + (1007 + 207),
    );
  });

  it('counts the borrowed texture once when the member rock is not in the preset', () => {
    const rock = textured('rock', 'rock', 300, 9000);
    const pile = pileOf('pile', rock);
    const input = inputOf([hdri(2000), rock, pile]);
    input.presets = [{ id: 'tank', biome: 'freshwater', assetIds: ['pile'] }];
    expect(presetDownloadBytes(input, input.presets[0]!, 'mobile')).toBe(2000 + 1007 + 207 + 300);
  });

  it('still throws when a texture is in no asset files[]', () => {
    const rock = textured('rock', 'rock', 300, 9000);
    const pile = pileOf('pile', rock);
    const input = inputOf([hdri(2000), pile]);
    input.presets = [{ id: 'tank', biome: 'freshwater', assetIds: ['pile'] }];
    expect(() => presetDownloadBytes(input, input.presets[0]!, 'mobile')).toThrow(
      /is not in files\[\]/,
    );
  });

  it('counts the HDRI, one LOD and the slot textures of mobile', () => {
    const input = inputOf([hdri(2000), textured('rock', 'rock', 300, 9000)]);
    expect(presetDownloadBytes(input, input.presets[0]!, 'mobile')).toBe(2000 + 1000 + 200 + 300);
  });

  it('counts both texture slots on desktop while collision still loads the low set', () => {
    const input = inputOf([hdri(2000), textured('rock', 'rock', 300, 9000)]);
    expect(presetDownloadBytes(input, input.presets[0]!, 'desktop')).toBe(
      2000 + 1000 + 200 + 300 + 9000,
    );
  });

  it('adds every LOD of the fish whose species lives in the preset biome only', () => {
    const tetra = { ...textured('tetra', 'fish', 100, 400), species: 'tetra' };
    const tang = { ...textured('tang', 'fish', 100, 400), species: 'tang' };
    const input = inputOf([hdri(0), textured('rock', 'rock', 0, 0), tetra, tang]);
    expect(presetDownloadBytes(input, input.presets[0]!, 'mobile')).toBe(1000 + 200 + 1700 + 100);
  });

  it('adds every LOD of a crab or snail whose species lives in the preset biome', () => {
    const crab = { ...textured('crab', 'crab', 100, 400), species: 'tetra' };
    const snail = { ...textured('snail', 'snail', 100, 400), species: 'tetra' };
    const reefSnail = { ...textured('reef-snail', 'snail', 100, 400), species: 'tang' };
    const input = inputOf([hdri(0), textured('rock', 'rock', 0, 0), crab, snail, reefSnail]);
    expect(presetDownloadBytes(input, input.presets[0]!, 'mobile')).toBe(
      1000 + 200 + 2 * (1700 + 100),
    );
  });

  it('counts the impostor atlases of a fish on both budgets', () => {
    const albedo = entry('fish/tetra/impostor_albedo.ktx2', 300);
    const normalDepth = entry('fish/tetra/impostor_normal.ktx2', 700);
    const base = textured('tetra', 'fish', 100, 400);
    const tetra: OutputAsset = {
      ...base,
      species: 'tetra',
      files: [...base.files, albedo, normalDepth],
      impostor: {
        sourceLod: 1,
        layout: 'octahedral',
        pose: 'rest',
        grid: 8,
        frameSize: 128,
        atlasSize: 1024,
        pivot: [0, 0, 0],
        radius: 0.02,
        albedo: { ...albedo, codec: 'etc1s' },
        normalDepth: { ...normalDepth, codec: 'uastc' },
      },
    };
    const input = inputOf([hdri(0), textured('rock', 'rock', 0, 0), tetra]);
    expect(presetDownloadBytes(input, input.presets[0]!, 'mobile')).toBe(
      1000 + 200 + 1700 + 100 + 1000,
    );
    expect(presetDownloadBytes(input, input.presets[0]!, 'desktop')).toBe(
      1000 + 200 + 1700 + 500 + 1000,
    );
  });

  it('skips procedural Euphyllia ids', () => {
    const input = inputOf([hdri(2000)]);
    input.presets[0]!.assetIds = ['euphyllia-hammer-3', 'euphyllia-torch-8'];
    expect(presetDownloadBytes(input, input.presets[0]!, 'mobile')).toBe(2000);
  });

  it('throws on an asset id that is neither in the index nor procedural', () => {
    const input = inputOf([hdri(2000)]);
    expect(() => presetDownloadBytes(input, input.presets[0]!, 'mobile')).toThrow(
      /unknown asset "rock"/,
    );
  });

  it('throws when the HDRI the web app loads is not in the index', () => {
    const input = inputOf([textured('rock', 'rock', 1, 1)]);
    expect(() => presetDownloadBytes(input, input.presets[0]!, 'mobile')).toThrow(
      /HDRI "studio-small-09"/,
    );
  });

  it('throws when the HDRI file is not one of the indexed files', () => {
    const input = {
      ...inputOf([hdri(5), textured('rock', 'rock', 1, 1)]),
      hdri: { ...HDRI, file: 'hdri/studio-small-09/other.hdr' },
    };
    expect(() => presetDownloadBytes(input, input.presets[0]!, 'mobile')).toThrow(/other\.hdr/);
  });
});

describe('budgetProblems', () => {
  const mobileLimit = TIER_BUDGETS.mobile.bytes - CODE_RESERVE_BYTES;

  it('passes a preset under both budgets', () => {
    expect(budgetProblems(inputOf([hdri(2000), textured('rock', 'rock', 300, 9000)]))).toEqual([]);
  });

  it('fails a preset over the mobile budget and names the tiers', () => {
    const problems = budgetProblems(inputOf([hdri(mobileLimit), textured('rock', 'rock', 10, 10)]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('preset tank on low/medium');
  });

  it('fails a preset over the desktop budget but not the mobile one', () => {
    const big = TIER_BUDGETS.desktop.bytes;
    const problems = budgetProblems(inputOf([hdri(2000), textured('rock', 'rock', 300, big)]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('high/ultra');
  });
});

describe('parseHdriUrl', () => {
  it('reads the id and file from the web constant', () => {
    expect(
      parseHdriUrl('export const DEFAULT_HDRI_URL = `${ASSET_BASE}hdri/kloof/kloof_1k.hdr`;'),
    ).toEqual({ id: 'kloof', file: 'hdri/kloof/kloof_1k.hdr' });
  });

  it('fails loudly when the constant changes shape', () => {
    expect(() => parseHdriUrl('export const DEFAULT_HDRI_URL = somethingElse;')).toThrow(
      /DEFAULT_HDRI_URL/,
    );
  });
});

describe('the committed presets', () => {
  it('load with their biome and asset ids', () => {
    const { presets, speciesBiome, hdri } = loadBudgetContent(
      resolve(import.meta.dirname, '../../..'),
    );
    expect(hdri.id).toBe('studio-small-09');
    expect(presets.map((p) => p.biome).sort()).toEqual([
      'blackwater',
      'cichlid',
      'freshwater',
      'mangrove',
      'reef',
    ]);
    expect(presets.every((p) => p.assetIds.length > 1)).toBe(true);
    expect(speciesBiome.get('neon-tetra')).toBe('freshwater');
  });
});
