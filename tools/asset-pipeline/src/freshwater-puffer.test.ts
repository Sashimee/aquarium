import { describe, expect, it } from 'vitest';
import { FRESHWATER_PUFFER_RECIPES, paintFigure8Puffer } from './freshwater-puffer.ts';
import { LOFT_FISH_RECIPES } from './loft-fish.ts';
import { MANGROVE_LOFT_RECIPES } from './mangrove.ts';

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
});
