import { describe, expect, it } from 'vitest';
import {
  BLACKWATER_FISH_RECIPES,
  paintApistoFemale,
  paintCardinal,
  paintRummyNose,
} from './blackwater-fish.ts';
import { FIN_ID_ATTRIBUTE, FIN_IDS } from './index-schema.ts';
import { loftFish } from './loft.ts';
import { loadTexture } from './loft-fish.ts';

/** FishBase length-length relationships, TL = b * SL, or the loft's own proportion where FishBase has none. */
const LITERATURE_TL_OVER_SL: Record<string, number> = {
  'cardinal-tetra': 1.1708,
  'rummy-nose-tetra': 1.2506,
};
const LOFT_OWN_PROPORTION = [
  'apistogramma-hongsloi',
  'apistogramma-hongsloi-male',
  'dwarf-pencilfish',
  'dwarf-pencilfish-male',
];

function lengthRatio(id: string): number {
  const recipe = BLACKWATER_FISH_RECIPES.find((r) => r.id === id);
  if (!recipe) throw new Error(`no recipe ${id}`);
  const part = loftFish({ ...recipe.spec, standardLengthM: 1 }, () => [0.5, 0.5], id);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 2; i < part.positions.length; i += 3) {
    min = Math.min(min, part.positions[i] ?? 0);
    max = Math.max(max, part.positions[i] ?? 0);
  }
  return max - min;
}

describe('blackwater lofts', () => {
  it('adds the four roster species, both sexes of two of them', () => {
    expect(BLACKWATER_FISH_RECIPES.map((r) => r.id).sort()).toEqual([
      'apistogramma-hongsloi',
      'apistogramma-hongsloi-male',
      'cardinal-tetra',
      'dwarf-pencilfish',
      'dwarf-pencilfish-male',
      'rummy-nose-tetra',
    ]);
  });

  it.each(Object.entries(LITERATURE_TL_OVER_SL))(
    '%s is drawn at its FishBase TL/SL within the size test tolerance',
    (id, ratio) => {
      expect(Math.abs(lengthRatio(id) / ratio - 1)).toBeLessThan(0.05);
    },
  );

  it.each(LOFT_OWN_PROPORTION)('%s has a plausible caudal-inclusive length', (id) => {
    expect(lengthRatio(id)).toBeGreaterThan(1.15);
    expect(lengthRatio(id)).toBeLessThan(1.3);
  });

  it.each(BLACKWATER_FISH_RECIPES.map((r) => r.id))(
    '%s has all five fin types and a body',
    (id) => {
      const recipe = BLACKWATER_FISH_RECIPES.find((r) => r.id === id);
      if (!recipe) throw new Error(id);
      const part = loftFish({ ...recipe.spec, standardLengthM: 0.04 }, () => [0.5, 0.5], id);
      const ids = new Set(part.extra[FIN_ID_ATTRIBUTE]);
      for (const fin of Object.values(FIN_IDS)) expect(ids.has(fin), `${id} fin ${fin}`).toBe(true);
    },
  );

  it.each(BLACKWATER_FISH_RECIPES.map((r) => r.id))(
    '%s gets translucent painted fins from its own atlas',
    async (id) => {
      const recipe = BLACKWATER_FISH_RECIPES.find((r) => r.id === id);
      if (!recipe) throw new Error(id);
      const texture = await loadTexture(recipe);
      expect(texture.finTexture).toBeDefined();
      expect(texture.image.height).toBeGreaterThan(0);
    },
    60_000,
  );
});

describe('painted tetra colours', () => {
  it('puts the cardinal neon stripe above a red flank', () => {
    const stripe = paintCardinal(0.5, 0.04);
    const flank = paintCardinal(0.6, -0.08);
    expect(stripe[2]).toBeGreaterThan(stripe[0]);
    expect(flank[0]).toBeGreaterThan(flank[2] * 3);
  });

  it('keeps the rummy-nose red to the head and the body silver', () => {
    const head = paintRummyNose(0.06, -0.02);
    const body = paintRummyNose(0.6, -0.02);
    expect(head[0]).toBeGreaterThan(head[1] * 4);
    expect(Math.abs(body[0] - body[2])).toBeLessThan(0.15);
  });

  it('paints a black lateral band on the apisto female', () => {
    const band = paintApistoFemale(0.5, 0);
    const belly = paintApistoFemale(0.5, -0.1);
    expect(band[0]).toBeLessThan(0.3);
    expect(belly[0]).toBeGreaterThan(0.6);
  });
});
