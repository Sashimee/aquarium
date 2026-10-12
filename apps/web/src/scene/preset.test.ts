import { describe, expect, it } from 'vitest';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { substrateHeight } from '../engine/tank/substrate';
import { loadPreset, parsePreset } from './preset';
import catalog from '../../public/assets/index.json';

const kinds = new Map(catalog.assets.map((a) => [a.id, a.kind]));

describe('freshwater preset', () => {
  const preset = loadPreset('freshwater');

  it('is the freshwater layout', () => {
    expect(preset.id).toBe('freshwater');
    expect(preset.biome).toBe('freshwater');
  });

  it('references only shipped assets of the right kind', () => {
    expect(kinds.get(preset.substrate?.assetId ?? '')).toBe('substrate');
    if (preset.substrate?.accentAssetId) {
      expect(kinds.get(preset.substrate.accentAssetId)).toBe('substrate');
    }
    for (const item of preset.decor) expect(kinds.has(item.assetId), item.assetId).toBe(true);
    for (const patch of preset.plantPatches) {
      expect(kinds.get(patch.assetId), patch.assetId).toBe('plant');
    }
  });

  it('seats rocks and wood on the substrate', () => {
    for (const item of preset.decor) {
      const kind = kinds.get(item.assetId);
      if (kind !== 'rock' && kind !== 'driftwood') continue;
      const ground = substrateHeight(DEFAULT_TANK, item.position[0], item.position[2]);
      expect(Math.abs(item.position[1] - ground), item.assetId).toBeLessThan(0.03);
    }
  });

  it('keeps decor inside the tank footprint', () => {
    for (const item of preset.decor) {
      expect(Math.abs(item.position[0])).toBeLessThan(DEFAULT_TANK.length / 2);
      expect(Math.abs(item.position[2])).toBeLessThan(DEFAULT_TANK.depth / 2);
    }
  });
});

describe('parsePreset', () => {
  it('names the preset and the failing field on invalid data', () => {
    expect(() => parsePreset({ id: 'x' }, 'broken.json')).toThrow(/broken\.json.*invalid/);
  });
});

describe('loadPreset', () => {
  it('fails clearly for a biome without a preset', () => {
    expect(() => loadPreset('reef')).toThrow(/reef/);
  });
});
