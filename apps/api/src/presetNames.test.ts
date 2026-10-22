import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertPresetNames } from './presetNames.ts';

const biomes = ['freshwater', 'reef'];

describe('assertPresetNames', () => {
  it('accepts exactly one preset per biome', () => {
    expect(() => assertPresetNames(['reef.json', 'freshwater.json'], biomes)).not.toThrow();
  });

  it('names a biome that has no preset file and says how to fix it', () => {
    expect(() => assertPresetNames(['freshwater.json'], biomes)).toThrow(
      /Biome "reef" has no preset\. Add content\/presets\/reef\.json/,
    );
  });

  it('names a preset file that is not a biome', () => {
    expect(() => assertPresetNames(['freshwater.json', 'reef.json', 'draft.json'], biomes)).toThrow(
      /content\/presets\/draft\.json is not a known biome/,
    );
  });

  it('reports every problem at once', () => {
    expect(() => assertPresetNames(['typo.json'], biomes)).toThrow(
      /typo\.json is not a known biome[\s\S]*"freshwater" has no preset[\s\S]*"reef" has no preset/,
    );
  });

  it('passes for the committed presets against the real biome list', () => {
    const files = readdirSync(new URL('../../../content/presets/', import.meta.url)).filter((n) =>
      n.endsWith('.json'),
    );
    expect(() => assertPresetNames(files)).not.toThrow();
  });
});
