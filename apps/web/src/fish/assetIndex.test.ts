import { describe, expect, it } from 'vitest';
import shippedIndex from '../../public/assets/index.json';
import { parseFishAssets } from './assetIndex';
import { DEMO_STOCKS } from './demoStock';
import { FISH_RENDER_PROFILES, renderProfile } from './profiles';

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

  it('maps each 1k map to its 2k file only where the 2k one is larger', () => {
    const variant = (file: string, size: number) => ({ file, size });
    const entry = parseFishAssets({
      assets: [
        fish({
          textures: [
            {
              role: 'baseColor',
              variants: {
                '1k': variant('fish/n/textures/base_1k.ktx2', 1024),
                '2k': variant('fish/n/textures/base_2k.ktx2', 1024),
              },
            },
            {
              role: 'normal',
              variants: {
                '1k': variant('fish/n/textures/normal_1k.ktx2', 512),
                '2k': variant('fish/n/textures/normal_2k.ktx2', 1024),
              },
            },
            { role: 'emissive', variants: { '1k': variant('fish/n/textures/e_1k.ktx2', 512) } },
          ],
        }),
      ],
    }).get('neon-tetra');
    expect(entry?.sharperTextures).toEqual(
      new Map([['fish/n/textures/normal_1k.ktx2', 'fish/n/textures/normal_2k.ktx2']]),
    );
  });

  it('has no 2k maps for an entry without textures', () => {
    expect(parseFishAssets({ assets: [fish()] }).get('neon-tetra')?.sharperTextures.size).toBe(0);
  });

  it.each([
    ['a parent directory', '../normal_2k.ktx2', 1024],
    ['a non-ktx2 file', 'fish/n/normal_2k.png', 1024],
    ['a missing size', 'fish/n/normal_2k.ktx2', undefined],
  ])('rejects %s in a 2k texture variant', (_, file, size) => {
    const textures = [
      {
        role: 'normal',
        variants: { '1k': { file: 'fish/n/normal_1k.ktx2', size: 512 }, '2k': { file, size } },
      },
    ];
    expect(() => parseFishAssets({ assets: [fish({ textures })] })).toThrow(TypeError);
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
      const male = profile.male === null ? [] : [profile.male.assetId];
      for (const assetId of [profile.assetId, ...male]) {
        const entry = entries.get(assetId);
        expect(entry, assetId).toBeDefined();
        expect(entry?.lodFiles.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('gives the shipped neon tetra its 2k normal map but keeps its single-size base colour', () => {
    const neon = parseFishAssets(shippedIndex).get('neon-tetra');
    expect(neon?.sharperTextures).toEqual(
      new Map([
        [
          'fish/neon-tetra/textures/neon-tetra_normal_1k.ktx2',
          'fish/neon-tetra/textures/neon-tetra_normal_2k.ktx2',
        ],
      ]),
    );
  });

  it('scales each male model by its profile length factor, so males draw at true size', () => {
    const entries = parseFishAssets(shippedIndex);
    const males = Object.values(FISH_RENDER_PROFILES).flatMap((p) =>
      p.male === null ? [] : [{ base: p.assetId, male: p.male }],
    );
    expect(males.length).toBeGreaterThan(0);
    for (const { base, male } of males) {
      const female = entries.get(base)?.standardLengthM;
      const own = entries.get(male.assetId)?.standardLengthM;
      if (female === undefined || own === undefined) throw new Error(`${male.assetId}: no model`);
      expect(own / female, male.assetId).toBeCloseTo(male.lengthFactor, 3);
    }
  });
});
