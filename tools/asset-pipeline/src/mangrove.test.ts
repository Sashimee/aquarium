import { describe, expect, it } from 'vitest';
import { LOFT_FISH_RECIPES } from './loft-fish.ts';
import {
  MANGROVE_ENVIRONMENT_RECIPES,
  MANGROVE_FISH_RECIPES,
  MANGROVE_LOFT_RECIPES,
  MANGROVE_SUBSTRATE_RECIPES,
  paintArcherfish,
  paintBumblebeeGoby,
  paintChromide,
  paintFigure8Puffer,
  paintMono,
} from './mangrove.ts';
import { ENVIRONMENT_RECIPES, FISH_RECIPES, SUBSTRATE_RECIPES } from './recipes.ts';

const PAINTERS = {
  'banded-archerfish': paintArcherfish,
  'silver-mono': paintMono,
  'figure-8-puffer': paintFigure8Puffer,
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
    expect(noReferences.sort()).toEqual(['figure-8-puffer', 'orange-chromide']);
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

  it('gives every fish a standard length in the sourced range', () => {
    for (const recipe of [...MANGROVE_FISH_RECIPES, ...MANGROVE_LOFT_RECIPES]) {
      expect(recipe.fallbackLengthM).toBeGreaterThan(0.02);
      expect(recipe.fallbackLengthM).toBeLessThan(0.2);
    }
  });
});
