import { Texture, type MeshStandardNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { TIERS, TIER_SETTINGS } from '../engine/quality/tiers';
import { plantDensityFor } from './plants';
import { createSubstrateMaterial, type SubstrateTextures } from './substrate';

const tank = { length: 1, depth: 0.5, height: 0.5, glass: 0.005 } as Parameters<
  typeof createSubstrateMaterial
>[2];

function textures(): SubstrateTextures {
  return {
    baseColor: new Texture(),
    normal: new Texture(),
    arm: new Texture(),
  };
}

function nodeCount(material: MeshStandardNodeMaterial): number {
  let n = 0;
  material.normalNode?.traverse(() => n++);
  material.colorNode?.traverse(() => n++);
  return n;
}

describe('plantDensityFor', () => {
  it('thins carpet and large-leaf species below the low tier density', () => {
    const base = TIER_SETTINGS.low.plantDensity;
    expect(plantDensityFor('low', 'staurogyne-repens', base)).toBeLessThan(base);
    expect(plantDensityFor('low', 'vallisneria', base)).toBeLessThan(base);
    expect(plantDensityFor('low', 'java-fern', base)).toBe(base);
  });

  it('leaves medium, high and ultra untouched for every species', () => {
    for (const tier of TIERS) {
      if (tier === 'low') continue;
      const base = TIER_SETTINGS[tier].plantDensity;
      for (const id of ['staurogyne-repens', 'vallisneria', 'amazon-sword', 'java-fern']) {
        expect(plantDensityFor(tier, id, base)).toBe(base);
      }
    }
  });
});

describe('createSubstrateMaterial cheap path', () => {
  const options = { tint: [1, 1, 1] as [number, number, number], tileMeters: 0.3 };
  const layers = { base: textures(), accent: textures() };

  it('builds a smaller graph than the full material', () => {
    const full = createSubstrateMaterial(layers, options, tank);
    const cheap = createSubstrateMaterial(layers, options, tank, true);
    expect(nodeCount(cheap)).toBeLessThan(nodeCount(full));
  });

  it('defaults to the full material', () => {
    const a = createSubstrateMaterial(layers, options, tank);
    const b = createSubstrateMaterial(layers, options, tank, false);
    expect(nodeCount(a)).toBe(nodeCount(b));
  });
});
