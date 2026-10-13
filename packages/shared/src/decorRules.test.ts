import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { presetLayoutSchema } from './species.js';
import { decorPositionLimits, findDecorProblems, isDecorAssetForBiome } from './decorRules.js';

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'));

describe('decor rules', () => {
  it.each(['freshwater', 'reef'] as const)('lets the %s preset through unchanged', (biome) => {
    const preset = presetLayoutSchema.parse(read(`content/presets/${biome}.json`));
    const patchAssets = preset.plantPatches.map((p) => ({
      assetId: p.assetId,
      position: [0, 0, 0] as [number, number, number],
      rotationY: 0,
      scale: 1,
    }));
    expect(findDecorProblems(biome, [...preset.decor, ...patchAssets], 'vacation-feeder')).toEqual(
      [],
    );
  });

  it('covers every catalog asset a layout can hold in at least one biome', () => {
    const index = read('apps/web/public/assets/index.json') as {
      assets: { id: string; kind: string }[];
    };
    const decorKinds = new Set(['rock', 'driftwood', 'decor', 'coral', 'anemone', 'plant']);
    const missing = index.assets
      .filter((a) => decorKinds.has(a.kind))
      .filter(
        (a) => !isDecorAssetForBiome('freshwater', a.id) && !isDecorAssetForBiome('reef', a.id),
      )
      .map((a) => a.id);
    expect(missing).toEqual([]);
  });

  it('keeps euphyllia ids reef-only', () => {
    expect(isDecorAssetForBiome('reef', 'euphyllia-hammer-12')).toBe(true);
    expect(isDecorAssetForBiome('freshwater', 'euphyllia-hammer-12')).toBe(false);
  });

  it('bounds the default tank interior', () => {
    expect(decorPositionLimits()).toEqual({ x: 0.6 - 0.01, z: 0.25 - 0.01, yMax: 0.5 });
  });
});
