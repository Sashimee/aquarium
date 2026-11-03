import { Texture, type MeshStandardNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { TIERS, TIER_SETTINGS } from '../engine/quality/tiers';
import { keyFor, sameKey, substrateReload } from './TankScene';
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

function samplesTexture(material: MeshStandardNodeMaterial, map: Texture): boolean {
  let found = false;
  const visit = (node: object) => {
    if ((node as { value?: unknown }).value === map) found = true;
  };
  material.normalNode?.traverse(visit);
  material.colorNode?.traverse(visit);
  return found;
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

  it('defaults to the full material, which samples the accent normal map the cheap one skips', () => {
    const accentNormal = layers.accent.normal;
    const implicit = createSubstrateMaterial(layers, options, tank);
    const full = createSubstrateMaterial(layers, options, tank, false);
    const cheap = createSubstrateMaterial(layers, options, tank, true);
    expect(samplesTexture(implicit, accentNormal)).toBe(true);
    expect(samplesTexture(full, accentNormal)).toBe(true);
    expect(samplesTexture(cheap, accentNormal)).toBe(false);
  });
});

describe('substrate rebuild key', () => {
  const settings = TIER_SETTINGS.low;

  it('differs between low and medium through cheapSubstrate alone', () => {
    const low = keyFor('low', settings);
    expect(sameKey(low, { ...low, cheapSubstrate: false })).toBe(false);
  });

  it('reloads when the cheap flag flips on a tank with an accent layer', () => {
    const low = keyFor('low', settings);
    const current = { textureSize: low.textureSize, cheap: false };
    expect(substrateReload(current, low, true)).toEqual({ reload: true, cheap: true });
  });

  it('keeps the substrate on a low-tier switch when there is no accent layer', () => {
    const low = keyFor('low', settings);
    const current = { textureSize: low.textureSize, cheap: false };
    expect(substrateReload(current, low, false)).toEqual({ reload: false, cheap: false });
  });

  it('still reloads for a texture size change or a missing install without an accent', () => {
    const low = keyFor('low', settings);
    expect(substrateReload({ textureSize: 99, cheap: false }, low, false).reload).toBe(true);
    expect(substrateReload(null, low, false).reload).toBe(true);
  });
});
