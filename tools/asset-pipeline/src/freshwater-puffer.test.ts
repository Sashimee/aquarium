import { describe, expect, it } from 'vitest';
import { FRESHWATER_PUFFER_RECIPES, paintFigure8Puffer } from './freshwater-puffer.ts';
import { LOFT_FISH_RECIPES } from './loft-fish.ts';
import {
  MANGROVE_ENVIRONMENT_RECIPES,
  MANGROVE_FISH_RECIPES,
  MANGROVE_LOFT_RECIPES,
  MANGROVE_SUBSTRATE_RECIPES,
} from './mangrove.ts';
import { ENVIRONMENT_RECIPES, FISH_RECIPES, SUBSTRATE_RECIPES } from './recipes.ts';

describe('freshwater puffer', () => {
  it('builds only the figure-8 puffer, and the mangrove set no longer claims it', () => {
    expect(FRESHWATER_PUFFER_RECIPES.map((r) => r.id)).toEqual(['figure-8-puffer']);
    expect(MANGROVE_LOFT_RECIPES.some((r) => r.id === 'figure-8-puffer')).toBe(false);
    expect(LOFT_FISH_RECIPES.some((r) => r.id === 'figure-8-puffer')).toBe(false);
  });

  it('paints finite colours in [0, 1] over the whole canvas', () => {
    for (let tn = -0.2; tn <= 1.5; tn += 0.05) {
      for (let yn = -1.5; yn <= 2.5; yn += 0.1) {
        for (const channel of paintFigure8Puffer(tn, yn)) {
          expect(Number.isFinite(channel)).toBe(true);
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('uses ids that no other recipe claims', () => {
    const mine = FRESHWATER_PUFFER_RECIPES.map((r) => r.id);
    const others = new Set([
      ...FISH_RECIPES.map((r) => r.id),
      ...LOFT_FISH_RECIPES.map((r) => r.id),
      ...ENVIRONMENT_RECIPES.map((r) => r.id),
      ...SUBSTRATE_RECIPES.map((r) => r.id),
      ...MANGROVE_FISH_RECIPES.map((r) => r.id),
      ...MANGROVE_LOFT_RECIPES.map((r) => r.id),
      ...MANGROVE_ENVIRONMENT_RECIPES.map((r) => r.id),
      ...MANGROVE_SUBSTRATE_RECIPES.map((r) => r.id),
    ]);
    expect(new Set(mine).size).toBe(mine.length);
    expect(mine.filter((id) => others.has(id))).toEqual([]);
  });

  it('keeps the loft canvas large enough for its snout and tail pixels', () => {
    for (const recipe of FRESHWATER_PUFFER_RECIPES) {
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

  it('never references the parked public-domain photo', () => {
    const used = FRESHWATER_PUFFER_RECIPES.flatMap((r) =>
      r.texture.kind === 'synthetic' ? (r.texture.references ?? []) : [],
    );
    expect(used).not.toContain('wm-figure8-geyer');
  });

  it('gives the puffer a standard length in the sourced range', () => {
    for (const recipe of FRESHWATER_PUFFER_RECIPES) {
      expect(recipe.fallbackLengthM).toBeGreaterThan(0.02);
      expect(recipe.fallbackLengthM).toBeLessThan(0.2);
    }
  });
});
