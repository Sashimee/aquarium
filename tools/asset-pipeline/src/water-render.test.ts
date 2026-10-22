import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CLEAR_WATER, gradeUnderwater } from './misty-lake.ts';
import { manifestSchema } from './manifest.ts';
import { sceneBaseColor, sceneMaterial } from './environment.ts';
import type { MaterialDef } from './parts.ts';
import { buildMips, type SceneMesh } from './soft-render.ts';
import {
  BLACKWATER_BACKGROUND_IDS,
  MANGROVE_BACKGROUND_IDS,
  WATER_BACKGROUND_IDS,
  renderWaterScene,
  type Library,
} from './water-render.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const manifest = manifestSchema.parse(
  JSON.parse(readFileSync(join(REPO, 'assets', 'manifest.json'), 'utf8')),
);
const byId = new Map(manifest.assets.map((a) => [a.id, a]));

describe('water backgrounds', () => {
  it('are manifest render entries for their biome with five slots each', () => {
    expect(BLACKWATER_BACKGROUND_IDS).toHaveLength(5);
    expect(MANGROVE_BACKGROUND_IDS).toHaveLength(5);
    for (const id of WATER_BACKGROUND_IDS) {
      const entry: Record<string, unknown> = { ...byId.get(id) };
      expect(entry['kind'], id).toBe('background');
      expect(entry['source'], id).toBe('render');
      expect(entry['biome'], id).toBe(id.startsWith('bg-blackwater-') ? 'blackwater' : 'mangrove');
      expect(['CC0-1.0', 'CC-BY-4.0'], id).toContain(entry['licence']);
    }
  });

  it('credit the CC-BY scans that set the licence', () => {
    const credited: Record<string, string> = {
      'bg-blackwater-root-tangle': 'HeartOfLines',
      'bg-blackwater-driftwood-wall': 'jasonwebb',
      'bg-mangrove-prop-root-thicket': 'lucq22',
      'bg-mangrove-petrified-stump': 'JFN (db4), lucq22',
    };
    for (const id of WATER_BACKGROUND_IDS) {
      const entry = byId.get(id);
      const author = credited[id];
      if (author) {
        expect(entry?.licence, id).toBe('CC-BY-4.0');
        expect(entry?.author, id).toContain(author);
      } else {
        expect(entry?.licence, id).toBe('CC0-1.0');
      }
    }
  });

  it('render distinct images', () => {
    const hashes = WATER_BACKGROUND_IDS.map((id) => byId.get(id)?.sha256);
    expect(new Set(hashes).size).toBe(WATER_BACKGROUND_IDS.length);
  });
});

function fixtureLibrary(): Library {
  const texture = buildMips({ width: 2, height: 2, data: new Uint8Array(16).fill(200) });
  const blob = (seed: number): SceneMesh => {
    const h = 0.4 + seed * 0.05;
    return {
      positions: Float32Array.from([-h, 0, 0, h, 0, 0, h, 2 * h, 0, -h, 2 * h, 0]),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      texture,
      castsShadow: true,
    };
  };
  const names = [
    'scanA',
    'scanB',
    'twigs',
    'trunk02',
    'quiver',
    'propRoots',
    'stump',
    'propagule',
    'rock',
    'rootScan',
  ] as const;
  const models = Object.fromEntries(names.map((n, i) => [n, [blob(i)]])) as Library['models'];
  return { models, litter: texture, mud: texture, mudSand: texture };
}

describe('water scene renders', () => {
  it('draw their models: removing the models changes the picture', () => {
    const library = fixtureLibrary();
    const bare: Library = {
      ...library,
      models: {
        scanA: [],
        scanB: [],
        twigs: [],
        trunk02: [],
        quiver: [],
        propRoots: [],
        stump: [],
        propagule: [],
        rock: [],
        rootScan: [],
      },
    };
    for (const id of WATER_BACKGROUND_IDS) {
      const withModels = renderWaterScene(id, library, 48, 64);
      const withoutModels = renderWaterScene(id, bare, 48, 64);
      expect(Buffer.from(withModels.rgb).equals(Buffer.from(withoutModels.rgb)), id).toBe(false);
      expect(
        withModels.depth.some((d, i) => d < (withoutModels.depth[i] ?? Infinity) - 1e-3),
        id,
      ).toBe(true);
    }
  });

  it('differ from each other', () => {
    const library = fixtureLibrary();
    const images = WATER_BACKGROUND_IDS.map((id) =>
      Buffer.from(renderWaterScene(id, library, 48, 64).rgb).toString('base64'),
    );
    expect(new Set(images).size).toBe(WATER_BACKGROUND_IDS.length);
  });
});

describe('sceneBaseColor', () => {
  it('throws when the part material is unknown', () => {
    expect(() => sceneMaterial(new Map(), 'bark', 'rock')).toThrow(/bark.*not in the loaded/);
  });

  it('warns when a material has no base colour texture', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const material: MaterialDef = {
      name: 'bark',
      baseColorFactor: [1, 1, 1, 1],
      roughness: 1,
      metallic: 0,
      alphaMode: 'OPAQUE',
      doubleSided: false,
      normalScale: 1,
    };
    expect(sceneBaseColor(material, 'bark', 'rock')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bark'));
    warn.mockRestore();
  });
});

describe('gradeUnderwater palettes', () => {
  const params = { near: 1.5, far: 14, focus: 3.6 };
  const size = 8;
  const grey = new Uint8Array(size * size * 3).fill(160);
  const far = new Uint8Array(size * size).fill(255);
  const mean = (image: Uint8Array, channel: number) => {
    let sum = 0;
    for (let p = 0; p < size * size; p++) sum += image[p * 3 + channel] ?? 0;
    return sum / (size * size);
  };

  it('defaults to the clear-water palette', () => {
    const a = gradeUnderwater(grey, far, params, size, size);
    const b = gradeUnderwater(grey, far, params, size, size, CLEAR_WATER);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('a tannin palette keeps red and loses blue', () => {
    const tannin = gradeUnderwater(grey, far, params, size, size, {
      absorption: [0.07, 0.17, 0.42],
      veilDensity: 0.05,
      veilTop: [128, 78, 34],
      veilBottom: [20, 10, 5],
      rayColour: [226, 168, 96],
      rayStrength: 0,
    });
    expect(mean(tannin, 0)).toBeGreaterThan(mean(tannin, 2));
  });
});
