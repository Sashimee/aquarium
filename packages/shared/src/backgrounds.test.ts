import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_IDS,
  DEFAULT_BACKGROUND_ID,
  backgroundEntrySchema,
  backgroundFileSchema,
  backgroundIdSchema,
  isBackgroundForBiome,
} from './backgrounds.js';
import { biomeSchema } from './common.js';

const dir = join(import.meta.dirname, '../../../content/backgrounds');
const read = (biome: string): unknown =>
  JSON.parse(readFileSync(join(dir, `${biome}.json`), 'utf8'));

describe('content/backgrounds', () => {
  it('has one file per biome and nothing else', () => {
    expect(readdirSync(dir).sort()).toEqual(biomeSchema.options.map((b) => `${b}.json`).sort());
  });

  it.each(biomeSchema.options)('%s.json passes the schema and matches the id enum', (biome) => {
    const entries = backgroundFileSchema.parse(read(biome));
    expect(entries).toHaveLength(5);
    expect(entries.every((e) => e.biome === biome)).toBe(true);
    expect(entries.map((e) => e.id)).toEqual([...BACKGROUND_IDS[biome]]);
  });

  it('defaults each biome to the first listed background', () => {
    for (const biome of biomeSchema.options) {
      expect(DEFAULT_BACKGROUND_ID[biome]).toBe(BACKGROUND_IDS[biome][0]);
    }
  });
});

describe('background schema', () => {
  const entry = { id: 'x', biome: 'reef', title: 'X', file: null, credit: null, licence: null };

  it('allows a missing file but requires credit and licence once there is one', () => {
    expect(backgroundEntrySchema.safeParse(entry).success).toBe(true);
    expect(backgroundEntrySchema.safeParse({ ...entry, file: 'x.ktx2' }).success).toBe(false);
    expect(
      backgroundEntrySchema.safeParse({ ...entry, file: 'x.ktx2', credit: 'A', licence: 'CC0' })
        .success,
    ).toBe(true);
  });

  it('rejects duplicate ids and unknown fields', () => {
    expect(backgroundFileSchema.safeParse([entry, entry]).success).toBe(false);
    expect(backgroundEntrySchema.safeParse({ ...entry, extra: 1 }).success).toBe(false);
  });

  it('checks an id against its biome', () => {
    expect(backgroundIdSchema.safeParse('coral-wall').success).toBe(true);
    expect(isBackgroundForBiome('reef', 'coral-wall')).toBe(true);
    expect(isBackgroundForBiome('freshwater', 'coral-wall')).toBe(false);
    expect(backgroundIdSchema.safeParse('nope').success).toBe(false);
  });
});
