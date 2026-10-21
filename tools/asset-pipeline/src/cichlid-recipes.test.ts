import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CICHLID_BACKGROUND_IDS } from './cichlid-render.ts';
import { CICHLID_LOFT_RECIPES } from './loft-cichlid-recipes.ts';
import { LOFT_FISH_RECIPES } from './loft-fish.ts';
import { manifestSchema } from './manifest.ts';
import { ENVIRONMENT_RECIPES, ROCK_PILE_RECIPES } from './recipes.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const manifest = manifestSchema.parse(
  JSON.parse(readFileSync(join(REPO, 'assets', 'manifest.json'), 'utf8')),
);
const byId = new Map(manifest.assets.map((a) => [a.id, a]));

describe('cichlid loft recipes', () => {
  it('are registered once each alongside the existing loft fish', () => {
    const ids = LOFT_FISH_RECIPES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const recipe of CICHLID_LOFT_RECIPES) expect(ids).toContain(recipe.id);
  });

  it('use ordered cross-sections inside the body length', () => {
    for (const recipe of CICHLID_LOFT_RECIPES) {
      const t = recipe.spec.sections.map((s) => s.t);
      expect(t, recipe.id).toEqual([...t].sort((a, b) => a - b));
      expect(t[0], recipe.id).toBeGreaterThanOrEqual(0);
      expect(t[t.length - 1], recipe.id).toBeLessThanOrEqual(1.001);
      expect(recipe.fallbackLengthM, recipe.id).toBeGreaterThan(0.03);
    }
  });

  it('never rest on a share-alike or unlicensed photo', () => {
    for (const recipe of CICHLID_LOFT_RECIPES) {
      if (recipe.texture.kind !== 'photo') continue;
      const source = byId.get(recipe.texture.sourceId);
      expect(['CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0'], recipe.id).toContain(source?.licence);
    }
  });
});

describe('rock piles', () => {
  it('place only rocks that have an environment recipe', () => {
    const rocks = new Set(ENVIRONMENT_RECIPES.map((r) => r.id));
    expect(ROCK_PILE_RECIPES.length).toBeGreaterThanOrEqual(2);
    for (const pile of ROCK_PILE_RECIPES)
      for (const placement of pile.placements) expect(rocks.has(placement.recipeId)).toBe(true);
  });

  it('differ in arrangement', () => {
    const arrangements = ROCK_PILE_RECIPES.map((pile) => JSON.stringify(pile.placements));
    expect(new Set(arrangements).size).toBe(arrangements.length);
  });
});

describe('cichlid backgrounds', () => {
  it('are manifest render entries for the cichlid biome', () => {
    for (const id of CICHLID_BACKGROUND_IDS) {
      const entry: Record<string, unknown> = { ...byId.get(id) };
      expect(entry['kind'], id).toBe('background');
      expect(entry['source'], id).toBe('render');
      expect(entry['biome'], id).toBe('cichlid');
      expect(['CC0-1.0', 'CC-BY-4.0'], id).toContain(entry['licence']);
    }
  });
});
