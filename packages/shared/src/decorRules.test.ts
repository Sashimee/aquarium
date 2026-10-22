import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { presetLayoutSchema } from './species.js';
import { fitPresetItem, presetFit } from './presetFit.js';
import { TANK_SIZES, type TankSize } from './tankSize.js';
import type { Biome, DecorItem } from './common.js';
import {
  DECOR_ASSET_IDS,
  decorPositionLimits,
  findDecorProblems,
  isDecorAssetForBiome,
  MUD_BANK_ASSET_ID,
  MUD_BANK_SCALE,
} from './decorRules.js';

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

  const NOT_DECOR = new Set([
    'fish',
    'shrimp',
    'crab',
    'snail',
    'substrate',
    'hdri',
    'background',
    'audio',
  ]);
  const BIOMES = Object.keys(DECOR_ASSET_IDS) as Biome[];
  const unclassified = (assets: { id: string; kind: string }[]) =>
    assets
      .filter((a) => !NOT_DECOR.has(a.kind))
      .filter((a) => !BIOMES.some((biome) => isDecorAssetForBiome(biome, a.id)))
      .map((a) => a.id);

  it('covers every catalog asset a layout can hold in at least one biome', () => {
    const index = read('apps/web/public/assets/index.json') as {
      assets: { id: string; kind: string }[];
    };
    expect(unclassified(index.assets)).toEqual([]);
  });

  it('flags an unclassified asset of a kind it has never seen', () => {
    expect(unclassified([{ id: 'ship-wreck', kind: 'ornament' }])).toEqual(['ship-wreck']);
  });

  it('keeps the malawi and tanganyika decor cichlid-only', () => {
    for (const id of [
      'malawi-boulder-03',
      'malawi-boulder-05',
      'malawi-rock-07',
      'rock-pile-stack',
      'rock-pile-cave',
      'neothauma-shell',
    ]) {
      expect(isDecorAssetForBiome('cichlid', id)).toBe(true);
      expect(isDecorAssetForBiome('reef', id)).toBe(false);
      expect(isDecorAssetForBiome('freshwater', id)).toBe(false);
    }
  });

  it('keeps the mangrove stump, prop roots and propagule out of other biomes', () => {
    for (const id of ['mangrove-stump', 'mangrove-prop-roots', 'mangrove-propagule']) {
      expect(isDecorAssetForBiome('mangrove', id)).toBe(true);
      expect(isDecorAssetForBiome('freshwater', id)).toBe(false);
      expect(isDecorAssetForBiome('reef', id)).toBe(false);
      expect(isDecorAssetForBiome('blackwater', id)).toBe(false);
    }
  });

  it('keeps the blackwater wood and leaves out of freshwater and reef', () => {
    for (const id of ['driftwood-scan-a', 'driftwood-scan-b', 'dry-branches', 'oak-leaf-card']) {
      expect(isDecorAssetForBiome('blackwater', id)).toBe(true);
      expect(isDecorAssetForBiome('freshwater', id)).toBe(false);
      expect(isDecorAssetForBiome('reef', id)).toBe(false);
    }
  });

  it('keeps euphyllia ids reef-only', () => {
    expect(isDecorAssetForBiome('reef', 'euphyllia-hammer-12')).toBe(true);
    expect(isDecorAssetForBiome('freshwater', 'euphyllia-hammer-12')).toBe(false);
  });

  it('keeps the mud bank mangrove-only and out of the shop', () => {
    expect(isDecorAssetForBiome('mangrove', MUD_BANK_ASSET_ID)).toBe(true);
    for (const biome of ['freshwater', 'reef', 'cichlid', 'blackwater'] as const) {
      expect(isDecorAssetForBiome(biome, MUD_BANK_ASSET_ID), biome).toBe(false);
    }
    expect(DECOR_ASSET_IDS.mangrove.has(MUD_BANK_ASSET_ID)).toBe(false);
  });

  it('bounds the default tank interior', () => {
    expect(decorPositionLimits()).toEqual({ x: 0.6 - 0.01, z: 0.25 - 0.01, yMax: 0.5 });
  });

  describe('mud bank', () => {
    const bank = (scale = 1): DecorItem => ({
      assetId: MUD_BANK_ASSET_ID,
      position: [0, 0.1, 0],
      rotationY: 0,
      scale,
    });

    it('allows one bank and rejects the second', () => {
      expect(findDecorProblems('mangrove', [bank()], 'vacation-feeder')).toEqual([]);
      expect(findDecorProblems('mangrove', [bank(), bank()], 'vacation-feeder')).toEqual([
        { index: 1, field: 'assetId', message: 'A tank holds one mud bank.' },
      ]);
    });

    it.each(Object.keys(TANK_SIZES) as TankSize[])(
      'accepts the mangrove preset bank fitted to %s, shrunk as far as the web fit allows',
      (size) => {
        const preset = presetLayoutSchema.parse(read('content/presets/mangrove.json'));
        const authored = preset.decor.find((item) => item.assetId === MUD_BANK_ASSET_ID);
        if (!authored) throw new Error('mangrove preset has no mud bank');
        const fitted = fitPresetItem(authored, size);
        const worst = {
          ...authored,
          scale: Math.max(0.05, authored.scale * presetFit(size).scale),
        };
        for (const bank of [fitted, worst]) {
          expect(findDecorProblems('mangrove', [bank], 'vacation-feeder'), size).toEqual([]);
        }
      },
    );

    it('holds the scale to its range, ends included', () => {
      for (const scale of [MUD_BANK_SCALE.min, MUD_BANK_SCALE.max, 1.3]) {
        expect(findDecorProblems('mangrove', [bank(scale)], 'vacation-feeder'), `${scale}`).toEqual(
          [],
        );
      }
      for (const scale of [MUD_BANK_SCALE.min / 2, MUD_BANK_SCALE.max * 2, 10]) {
        expect(
          findDecorProblems('mangrove', [bank(scale)], 'vacation-feeder').map((p) => p.field),
          `${scale}`,
        ).toEqual(['scale']);
      }
    });
  });
});
