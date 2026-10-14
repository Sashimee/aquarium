import { describe, expect, it } from 'vitest';
import shippedIndex from '../../public/assets/index.json';
import { parseFishAssets } from './assetIndex';
import { DEMO_STOCKS } from './demoStock';
import { renderProfile } from './profiles';

function fish(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'neon-tetra',
    kind: 'fish',
    species: 'neon-tetra',
    bounds: { min: [-0.003, -0.005, -0.02], max: [0.003, 0.005, 0.012] },
    lods: [{ file: 'fish/neon-tetra/lod0.glb' }, { file: 'fish/neon-tetra/lod1.glb' }],
    fish: { standardLengthM: 0.032 },
    ...overrides,
  };
}

describe('parseFishAssets', () => {
  it('reads fish entries and skips other asset kinds', () => {
    const entries = parseFishAssets({
      assets: [fish(), { id: 'sand', kind: 'texture', files: ['x.ktx2'] }],
    });
    expect([...entries.keys()]).toEqual(['neon-tetra']);
    const neon = entries.get('neon-tetra');
    expect(neon?.lodFiles).toEqual(['fish/neon-tetra/lod0.glb', 'fish/neon-tetra/lod1.glb']);
    expect(neon?.standardLengthM).toBe(0.032);
    expect(neon?.min).toEqual([-0.003, -0.005, -0.02]);
  });

  it('accepts an index with no fish', () => {
    expect(parseFishAssets({ assets: [] }).size).toBe(0);
  });

  it.each([
    ['a parent directory', '../secrets/lod0.glb'],
    ['a nested parent directory', 'fish/../../lod0.glb'],
    ['an absolute path', '/etc/lod0.glb'],
    ['a non-glb file', 'fish/neon-tetra/lod0.js'],
  ])('rejects %s in an LOD path', (_, file) => {
    expect(() => parseFishAssets({ assets: [fish({ lods: [{ file }] })] })).toThrow(TypeError);
  });

  it('rejects malformed entries', () => {
    expect(() => parseFishAssets(null)).toThrow(TypeError);
    expect(() => parseFishAssets({})).toThrow(TypeError);
    expect(() => parseFishAssets({ assets: [fish({ lods: [] })] })).toThrow(TypeError);
    expect(() => parseFishAssets({ assets: [fish({ fish: { standardLengthM: 0 } })] })).toThrow(
      TypeError,
    );
    expect(() =>
      parseFishAssets({ assets: [fish({ bounds: { min: [0, 0, 0], max: [1, 1, 0] } })] }),
    ).toThrow(TypeError);
    expect(() =>
      parseFishAssets({ assets: [fish({ bounds: { min: [0, 0], max: [1, 1, 1] } })] }),
    ).toThrow(TypeError);
  });

  it('parses the shipped index and has a model for every demo species', () => {
    const entries = parseFishAssets(shippedIndex);
    for (const species of Object.values(DEMO_STOCKS).flatMap((s) => s.species)) {
      const profile = renderProfile(species.id);
      for (const assetId of [profile.assetId, ...profile.variants.map((v) => v.assetId)]) {
        const entry = entries.get(assetId);
        expect(entry, assetId).toBeDefined();
        expect(entry?.lodFiles.length).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
