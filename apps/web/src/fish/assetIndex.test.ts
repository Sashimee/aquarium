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

  it('reads a shrimp with its tail-curl rig, and gives fish none', () => {
    const shrimp = fish({
      id: 'cherry-shrimp',
      kind: 'shrimp',
      fish: undefined,
      shrimp: {
        standardLengthM: 0.037,
        abdomenHinge: { y: 0.001, z: -0.002 },
        telsonZ: -0.016,
        legPairs: 5,
        standoffM: 0.0046,
      },
    });
    const entries = parseFishAssets({ assets: [fish(), shrimp] });
    expect(entries.get('neon-tetra')?.shrimp).toBeNull();
    expect(entries.get('neon-tetra')?.kind).toBe('fish');
    const cherry = entries.get('cherry-shrimp');
    expect(cherry?.kind).toBe('shrimp');
    expect(cherry?.standardLengthM).toBe(0.037);
    expect(cherry?.standoff).toBe(0.0046);
    expect(entries.get('neon-tetra')?.standoff).toBeNull();
    expect(cherry?.shrimp).toEqual({
      hinge: { y: 0.001, z: -0.002 },
      telsonZ: -0.016,
      legPairs: 5,
    });
  });

  it.each([
    ['no hinge', { abdomenHinge: undefined }],
    ['a telson ahead of the hinge', { telsonZ: 0.01 }],
    ['a telson on the hinge', { telsonZ: -0.002 }],
    ['a fractional leg count', { legPairs: 4.5 }],
    ['no leg slots, which only a snail model may have', { legPairs: 0 }],
    ['a non-finite hinge', { abdomenHinge: { y: Number.NaN, z: -0.002 } }],
    ['no standoff', { standoffM: undefined }],
    ['feet above its origin', { standoffM: -0.001 }],
  ])('rejects a shrimp or a crab with %s', (_, override) => {
    for (const kind of ['shrimp', 'crab']) {
      const walker = fish({
        kind,
        fish: undefined,
        [kind]: {
          standardLengthM: 0.037,
          abdomenHinge: { y: 0, z: -0.002 },
          telsonZ: -0.016,
          legPairs: 5,
          standoffM: 0.0046,
          ...override,
        },
      });
      expect(() => parseFishAssets({ assets: [walker] }), kind).toThrow(TypeError);
    }
  });

  it('reads a crab with the same leg rig as a shrimp', () => {
    const crab = fish({
      id: 'hermit-crab',
      kind: 'crab',
      fish: undefined,
      crab: {
        standardLengthM: 0.03,
        abdomenHinge: { y: 0.0006, z: 0.0057 },
        telsonZ: -0.0155,
        legPairs: 5,
        standoffM: 0.0082,
      },
    });
    const entry = parseFishAssets({ assets: [crab] }).get('hermit-crab');
    expect(entry?.kind).toBe('crab');
    expect(entry?.standoff).toBe(0.0082);
    expect(entry?.shrimp).toEqual({
      hinge: { y: 0.0006, z: 0.0057 },
      telsonZ: -0.0155,
      legPairs: 5,
    });
  });

  it('reads a snail with no leg rig, standing on its origin', () => {
    const snail = fish({
      id: 'nerite-snail',
      kind: 'snail',
      fish: undefined,
      snail: { standardLengthM: 0.02, origin: 'foot-centre' },
    });
    const entry = parseFishAssets({ assets: [snail] }).get('nerite-snail');
    expect(entry?.kind).toBe('snail');
    expect(entry?.standardLengthM).toBe(0.02);
    expect(entry?.shrimp).toBeNull();
    expect(entry?.standoff).toBe(0);
  });

  it('rejects a snail whose origin is not on its sole', () => {
    const snail = fish({
      kind: 'snail',
      fish: undefined,
      snail: { standardLengthM: 0.02, origin: 'centre-of-mass' },
    });
    expect(() => parseFishAssets({ assets: [snail] })).toThrow(/snail\.origin/);
  });

  it('parses the shipped hermit crab and nerite snail as their own kinds', () => {
    const entries = parseFishAssets(shippedIndex);
    const crab = entries.get('hermit-crab');
    expect(crab?.kind).toBe('crab');
    expect(crab?.shrimp?.legPairs).toBe(5);
    expect(crab?.standoff).toBeGreaterThan(0);
    const snail = entries.get('nerite-snail');
    expect(snail?.kind).toBe('snail');
    expect(snail?.shrimp).toBeNull();
    expect(snail?.standoff).toBe(0);
  });

  it('parses both shipped shrimp with a hinge ahead of the telson', () => {
    const entries = parseFishAssets(shippedIndex);
    for (const id of ['cherry-shrimp', 'cleaner-shrimp']) {
      const rig = entries.get(id)?.shrimp;
      expect(rig, id).toBeDefined();
      expect(rig?.legPairs, id).toBe(5);
      expect(rig?.telsonZ, id).toBeLessThan(rig?.hinge.z ?? -Infinity);
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
  describe('impostor atlas', () => {
    const atlas = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      sourceLod: 1,
      layout: 'octahedral',
      pose: 'rest',
      grid: 9,
      frameSize: 128,
      atlasSize: 1152,
      pivot: [0, 0.0002, -0.0037],
      radius: 0.0144,
      albedo: { file: 'fish/neon-tetra/impostor_albedo.ktx2', codec: 'etc1s' },
      normalDepth: { file: 'fish/neon-tetra/impostor_normal.ktx2', codec: 'uastc' },
      ...overrides,
    });

    it('reads the frame layout and both files', () => {
      const entry = parseFishAssets({ assets: [fish({ impostor: atlas() })] }).get('neon-tetra');
      expect(entry?.impostor).toEqual({
        grid: 9,
        frameSize: 128,
        pivot: [0, 0.0002, -0.0037],
        radius: 0.0144,
        albedoFile: 'fish/neon-tetra/impostor_albedo.ktx2',
        normalFile: 'fish/neon-tetra/impostor_normal.ktx2',
      });
    });

    it('is null for an entry the pipeline baked none for', () => {
      expect(parseFishAssets({ assets: [fish()] }).get('neon-tetra')?.impostor).toBeNull();
    });

    it.each([
      ['another layout', { layout: 'hemi-octahedral' }],
      ['an even grid, which has no frame on the axes', { grid: 8, atlasSize: 1024 }],
      ['an atlas that is not grid * frameSize', { atlasSize: 1024 }],
      ['a frame size that is not a power of two', { frameSize: 100, atlasSize: 900 }],
      ['no radius', { radius: 0 }],
      ['a non-finite pivot', { pivot: [0, Number.NaN, 0] }],
      ['an albedo outside the assets folder', { albedo: { file: '../albedo.ktx2' } }],
      ['a normal atlas that is not KTX2', { normalDepth: { file: 'fish/n/normal.png' } }],
    ])('rejects %s', (_, override) => {
      expect(() => parseFishAssets({ assets: [fish({ impostor: atlas(override) })] })).toThrow(
        TypeError,
      );
    });

    it('is shipped for every fish model', () => {
      for (const entry of parseFishAssets(shippedIndex).values()) {
        if (entry.kind === 'fish') expect(entry.impostor?.grid, entry.id).toBe(9);
      }
    });
  });
});
