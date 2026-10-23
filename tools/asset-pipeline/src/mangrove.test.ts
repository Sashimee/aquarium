import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assetIndexSchema, type OutputAsset } from './index-schema.ts';
import { LOFT_FISH_RECIPES } from './loft-fish.ts';
import {
  MANGROVE_ENVIRONMENT_RECIPES,
  MANGROVE_FISH_RECIPES,
  MANGROVE_LOFT_RECIPES,
  MANGROVE_SUBSTRATE_RECIPES,
  paintArcherfish,
  paintBumblebeeGoby,
  paintChromide,
  paintMono,
} from './mangrove.ts';
import { ENVIRONMENT_RECIPES, FISH_RECIPES, SUBSTRATE_RECIPES } from './recipes.ts';

const INDEX_URL = new URL('../../../apps/web/public/assets/index.json', import.meta.url);

function shipped(id: string): OutputAsset {
  const index = assetIndexSchema.parse(JSON.parse(readFileSync(INDEX_URL, 'utf8')));
  const asset = index.assets.find((a) => a.id === id);
  if (!asset) throw new Error(`${id} is not in assets/index.json`);
  return asset;
}

const PAINTERS = {
  'banded-archerfish': paintArcherfish,
  'silver-mono': paintMono,
  'bumblebee-goby': paintBumblebeeGoby,
  'orange-chromide': paintChromide,
};

describe('mangrove recipes', () => {
  it('uses ids that no other recipe claims', () => {
    const mine = [
      ...MANGROVE_FISH_RECIPES.map((r) => r.id),
      ...MANGROVE_LOFT_RECIPES.map((r) => r.id),
      ...MANGROVE_ENVIRONMENT_RECIPES.map((r) => r.id),
      ...MANGROVE_SUBSTRATE_RECIPES.map((r) => r.id),
    ];
    const others = new Set([
      ...FISH_RECIPES.map((r) => r.id),
      ...LOFT_FISH_RECIPES.map((r) => r.id),
      ...ENVIRONMENT_RECIPES.map((r) => r.id),
      ...SUBSTRATE_RECIPES.map((r) => r.id),
    ]);
    expect(new Set(mine).size).toBe(mine.length);
    expect(mine.filter((id) => others.has(id))).toEqual([]);
  });

  it('keeps every loft canvas large enough for its snout and tail pixels', () => {
    for (const recipe of MANGROVE_LOFT_RECIPES) {
      expect(recipe.texture.kind).toBe('synthetic');
      if (recipe.texture.kind !== 'synthetic') continue;
      const { width, height, snoutPixel, tailPixel } = recipe.texture;
      for (const [x, y] of [snoutPixel, tailPixel]) {
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(width);
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(height);
      }
      expect(tailPixel[0] - snoutPixel[0]).toBeGreaterThan(width / 2);
    }
  });

  it('paints finite colours in [0, 1] over the whole canvas', () => {
    for (const recipe of MANGROVE_LOFT_RECIPES) {
      const paint = PAINTERS[recipe.id as keyof typeof PAINTERS];
      expect(paint, recipe.id).toBeDefined();
      for (let tn = -0.2; tn <= 1.5; tn += 0.05) {
        for (let yn = -1.5; yn <= 2.5; yn += 0.1) {
          const colour = paint(tn, yn);
          for (const channel of colour) {
            expect(Number.isFinite(channel)).toBe(true);
            expect(channel).toBeGreaterThanOrEqual(0);
            expect(channel).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('only cites reference photos for fish that have an allowed one', () => {
    const noReferences = MANGROVE_LOFT_RECIPES.filter(
      (r) => r.texture.kind === 'synthetic' && !r.texture.references?.length,
    ).map((r) => r.id);
    expect(noReferences.sort()).toEqual(['orange-chromide']);
  });

  it('never references the parked public-domain photos', () => {
    const parked = [
      'wm-figure8-geyer',
      'wm-bumblebee-malamut',
      'wm-chromide-raghu',
      'wm-mangrove-roots-hillebrand',
    ];
    const used = MANGROVE_LOFT_RECIPES.flatMap((r) =>
      r.texture.kind === 'synthetic' ? (r.texture.references ?? []) : [],
    );
    expect(used.filter((id) => parked.includes(id))).toEqual([]);
  });

  it('keeps environment assets inside their triangle and size budgets', () => {
    for (const recipe of MANGROVE_ENVIRONMENT_RECIPES) {
      expect(recipe.maxTriangles).toBeLessThanOrEqual(20000);
      expect(recipe.longestM).toBeGreaterThan(0.1);
      expect(recipe.longestM).toBeLessThanOrEqual(0.35);
    }
  });

  it('builds mudskippers whose TL/SL matches FishBase within 10%', () => {
    const literature: Record<string, number> = {
      'barred-mudskipper': 1 / 0.8241,
      'blue-spotted-mudskipper': 1.1773,
    };
    for (const [id, tlOverSl] of Object.entries(literature)) {
      const asset = shipped(id);
      const tl = (asset.bounds?.max[2] ?? 0) - (asset.bounds?.min[2] ?? 0);
      const standardLengthM = asset.fish?.standardLengthM ?? 0;
      expect(standardLengthM, id).toBeGreaterThan(0);
      expect(Math.abs(tl / standardLengthM / tlOverSl - 1), id).toBeLessThan(0.1);
    }
  });

  it('ships scan LODs near their planned triangle ratios', () => {
    for (const recipe of MANGROVE_FISH_RECIPES) {
      const plan = recipe.lodPlan;
      if (!plan) throw new Error(`${recipe.id}: scan recipes carry an explicit LOD plan`);
      const triangles = shipped(recipe.id).lods.map((lod) => lod.triangles);
      const top = triangles[0] ?? 0;
      for (const level of [1, 2] as const) {
        const planned = plan.ratios[level] / plan.ratios[0];
        const actual = (triangles[level] ?? 0) / top;
        expect(actual / planned, `${recipe.id} LOD${level}`).toBeGreaterThan(0.75);
        expect(actual / planned, `${recipe.id} LOD${level}`).toBeLessThan(1.25);
      }
    }
  });

  it('caps the prop-root normal map at the 1k tier size', () => {
    const roots = shipped('mangrove-prop-roots').textures.find((t) => t.role === 'normal');
    expect(roots?.variants['2k'].size).toBe(512);
  });

  it('gives every fish a standard length in the sourced range', () => {
    for (const recipe of [...MANGROVE_FISH_RECIPES, ...MANGROVE_LOFT_RECIPES]) {
      expect(recipe.fallbackLengthM).toBeGreaterThan(0.02);
      expect(recipe.fallbackLengthM).toBeLessThan(0.2);
    }
  });
});
