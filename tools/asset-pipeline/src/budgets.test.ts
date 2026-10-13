import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODE_RESERVE_BYTES,
  DEFAULT_HDRI_ID,
  TIER_BUDGETS,
  budgetProblems,
  loadBudgetContent,
  presetDownloadBytes,
  type BudgetInput,
} from './budgets.ts';
import type { AssetIndex, OutputAsset } from './index-schema.ts';

const DIGEST = 'b'.repeat(64);

function entry(file: string, bytes: number) {
  return { file, bytes, sha256: DIGEST };
}

function variant(file: string, bytes: number) {
  return { ...entry(file, bytes), size: 1024 };
}

function textured(id: string, kind: OutputAsset['kind'], low: number, high: number): OutputAsset {
  const lod = { ...entry(`${kind}/${id}/lod0.glb`, 1000), triangles: 10, vertices: 10 };
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
    lods: [lod, lod1],
    textures: [
      {
        name: `${id}_normal`,
        role: 'normal',
        codec: 'etc1s',
        colorSpace: 'linear',
        variants: { '1k': variant(lowFile, low), '2k': variant(highFile, high) },
      },
    ],
    files: [lod, lod1, entry(lowFile, low), entry(highFile, high)].map(
      ({ file, bytes, sha256 }) => ({ file, bytes, sha256 }),
    ),
  };
}

function hdri(bytes: number): OutputAsset {
  const file = entry(`hdri/${DEFAULT_HDRI_ID}/env.hdr`, bytes);
  return {
    id: DEFAULT_HDRI_ID,
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
    presets: [{ id: 'tank', biome: 'freshwater', assetIds: ['rock'] }],
    speciesBiome: new Map([
      ['tetra', 'freshwater'],
      ['tang', 'reef'],
    ]),
  };
}

describe('presetDownloadBytes', () => {
  it('counts the HDRI, one LOD and the slot textures of mobile', () => {
    const input = inputOf([hdri(2000), textured('rock', 'rock', 300, 9000)]);
    expect(presetDownloadBytes(input, input.presets[0]!, 'mobile')).toBe(2000 + 1000 + 300);
  });

  it('counts both texture slots on desktop while collision still loads the low set', () => {
    const input = inputOf([hdri(2000), textured('rock', 'rock', 300, 9000)]);
    expect(presetDownloadBytes(input, input.presets[0]!, 'desktop')).toBe(2000 + 1000 + 300 + 9000);
  });

  it('adds every LOD of the fish whose species lives in the preset biome only', () => {
    const tetra = { ...textured('tetra', 'fish', 100, 400), species: 'tetra' };
    const tang = { ...textured('tang', 'fish', 100, 400), species: 'tang' };
    const input = inputOf([hdri(0), textured('rock', 'rock', 0, 0), tetra, tang]);
    expect(presetDownloadBytes(input, input.presets[0]!, 'mobile')).toBe(1000 + 1500 + 100);
  });

  it('skips ids without files because they are procedural', () => {
    const input = inputOf([hdri(2000)]);
    expect(presetDownloadBytes(input, input.presets[0]!, 'mobile')).toBe(2000);
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

describe('the committed presets', () => {
  it('load with their biome and asset ids', () => {
    const { presets, speciesBiome } = loadBudgetContent(resolve(import.meta.dirname, '../../..'));
    expect(presets.map((p) => p.biome).sort()).toEqual(['freshwater', 'reef']);
    expect(presets.every((p) => p.assetIds.length > 1)).toBe(true);
    expect(speciesBiome.get('neon-tetra')).toBe('freshwater');
  });
});
