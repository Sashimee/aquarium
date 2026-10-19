import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_IDS,
  DEFAULT_BACKGROUND_ID,
  backgroundEntrySchema,
  backgroundFileSchema,
  backgroundIdSchema,
  BACKGROUND_MAX_BYTES,
  BACKGROUND_TIERS,
  isBackgroundForBiome,
} from './backgrounds.js';
import { playableBiomeSchema } from './common.js';

const dir = join(import.meta.dirname, '../../../content/backgrounds');
const read = (biome: string): unknown =>
  JSON.parse(readFileSync(join(dir, `${biome}.json`), 'utf8'));

describe('content/backgrounds', () => {
  it('has one file per biome and nothing else', () => {
    expect(readdirSync(dir).sort()).toEqual(
      playableBiomeSchema.options.map((b) => `${b}.json`).sort(),
    );
  });

  it.each(playableBiomeSchema.options)(
    '%s.json passes the schema and matches the id enum',
    (biome) => {
      const entries = backgroundFileSchema.parse(read(biome));
      expect(entries).toHaveLength(5);
      expect(entries.every((e) => e.biome === biome)).toBe(true);
      expect(entries.map((e) => e.id)).toEqual([...BACKGROUND_IDS[biome]]);
    },
  );

  it('defaults each biome to the first listed background', () => {
    for (const biome of playableBiomeSchema.options) {
      expect(DEFAULT_BACKGROUND_ID[biome]).toBe(BACKGROUND_IDS[biome][0]);
    }
  });
});

describe('background schema', () => {
  const entry = { id: 'x', biome: 'reef', title: 'X', file: null, asset: null };

  it('allows a missing file but requires the manifest asset id once there is one', () => {
    expect(backgroundEntrySchema.safeParse(entry).success).toBe(true);
    const withFile = { ...entry, file: 'x.ktx2' };
    const missing = backgroundEntrySchema.safeParse(withFile);
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.path).toEqual(['asset']);
    expect(backgroundEntrySchema.safeParse({ ...withFile, asset: 'bg-x' }).success).toBe(true);
  });

  it('only accepts relative .ktx2 files', () => {
    for (const file of [
      'x.png',
      'x.ktx2.png',
      '/etc/x.ktx2',
      '../x.ktx2',
      'a/../x.ktx2',
      'x.KTX2',
      'a//x.ktx2',
      './x.ktx2',
      'a/./x.ktx2',
    ]) {
      expect(backgroundEntrySchema.safeParse({ ...entry, file, asset: 'bg-x' }).success, file).toBe(
        false,
      );
    }
    expect(
      backgroundEntrySchema.safeParse({ ...entry, file: 'reef/x.ktx2', asset: 'bg-x' }).success,
    ).toBe(true);
  });

  it('carries no licence or credit of its own', () => {
    expect(backgroundEntrySchema.safeParse({ ...entry, licence: 'CC0-1.0' }).success).toBe(false);
    expect(backgroundEntrySchema.safeParse({ ...entry, credit: 'A' }).success).toBe(false);
  });

  it('fixes the tier sizes and the byte budget from PLAN 9.2', () => {
    expect(BACKGROUND_TIERS).toEqual({
      ultra: [2048, 1024],
      high: [2048, 1024],
      medium: [1024, 512],
      low: [512, 256],
    });
    expect(BACKGROUND_MAX_BYTES).toBe(600_000);
  });

  it('rejects duplicate ids and unknown fields', () => {
    expect(backgroundFileSchema.safeParse([entry, entry]).success).toBe(false);
    expect(backgroundEntrySchema.safeParse({ ...entry, extra: 1 }).success).toBe(false);
  });

  it('checks an id against its biome', () => {
    expect(backgroundIdSchema.safeParse('bg-reef-coral-wall').success).toBe(true);
    expect(isBackgroundForBiome('reef', 'bg-reef-coral-wall')).toBe(true);
    expect(isBackgroundForBiome('freshwater', 'bg-reef-coral-wall')).toBe(false);
    expect(backgroundIdSchema.safeParse('nope').success).toBe(false);
  });

  it('lists every per-biome id in the id enum, and no others', () => {
    expect([...backgroundIdSchema.options].sort()).toEqual(
      Object.values(BACKGROUND_IDS).flat().sort(),
    );
  });
});
