import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLEAR_WATER, gradeUnderwater } from './misty-lake.ts';
import { manifestSchema } from './manifest.ts';
import {
  BLACKWATER_BACKGROUND_IDS,
  MANGROVE_BACKGROUND_IDS,
  WATER_BACKGROUND_IDS,
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
