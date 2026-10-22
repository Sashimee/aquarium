import { biomeSchema, creatableBiomeSchema } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { layoutPlants } from './plants.ts';
import { loadPresets } from './presets.ts';

describe('presets', () => {
  const presets = loadPresets();

  it('loads a non-empty preset for every creatable biome', () => {
    for (const biome of creatableBiomeSchema.options) {
      expect(presets[biome]?.decor.length, biome).toBeGreaterThan(0);
    }
  });

  it('loads a preset for every known biome', () => {
    expect(Object.keys(presets).sort()).toEqual([...biomeSchema.options].sort());
  });

  it('shows the biome preset decor on a tank with no saved layout', () => {
    for (const biome of ['cichlid', 'blackwater', 'mangrove'] as const) {
      const shown = layoutPlants(
        { biome, size: 'standard', decorLayout: null, plants: null },
        presets,
      );
      const expected = presets[biome]?.decor.map((item) => item.assetId);
      expect(expected?.length, biome).toBeGreaterThan(0);
      expect(
        shown.map((item) => item.assetId),
        biome,
      ).toEqual(expected);
    }
  });
});
