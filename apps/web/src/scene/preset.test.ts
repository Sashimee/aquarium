import { describe, expect, it } from 'vitest';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { substrateHeight } from '../engine/tank/substrate';
import { loadPreset, parsePreset } from './preset';
import catalog from '../../public/assets/index.json';
import { generateEuphyllia, parseEuphylliaId } from './euphyllia';

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

describe('reef preset', () => {
  const preset = loadPreset('reef');
  const entries = new Map(catalog.assets.map((a) => [a.id, a]));

  it('is the reef layout with live rock, corals and one host anemone', () => {
    expect(preset.biome).toBe('reef');
    const kindsUsed = preset.decor.map((d) => kinds.get(d.assetId));
    expect(kindsUsed.filter((k) => k === 'anemone')).toHaveLength(1);
    expect(kindsUsed.filter((k) => k === 'rock').length).toBeGreaterThanOrEqual(5);
    const corals = new Set(
      preset.decor.filter((d) => kinds.get(d.assetId) === 'coral').map((d) => d.assetId),
    );
    expect(corals).toContain('brain-coral');
    expect(corals).toContain('acropora-palmata');
    expect(kinds.get(preset.substrate?.assetId ?? '')).toBe('substrate');
  });

  it('references only shipped assets', () => {
    for (const item of preset.decor) {
      expect(kinds.has(item.assetId) || parseEuphylliaId(item.assetId), item.assetId).toBeTruthy();
    }
  });

  it('places a hammer and a torch Euphyllia colony', () => {
    const variants = preset.decor.map((d) => parseEuphylliaId(d.assetId)?.variant);
    expect(variants).toContain('hammer');
    expect(variants).toContain('torch');
  });

  it('keeps every footprint, with room for the anemone to sway, inside the glass', () => {
    const halfL = DEFAULT_TANK.length / 2 - DEFAULT_TANK.glass;
    const halfD = DEFAULT_TANK.depth / 2 - DEFAULT_TANK.glass;
    for (const item of preset.decor) {
      const procedural = parseEuphylliaId(item.assetId);
      const bounds = procedural
        ? generateEuphyllia(procedural.variant, procedural.seed, 2).bounds
        : entries.get(item.assetId)?.bounds;
      if (!bounds) throw new Error(`${item.assetId} has no bounds`);
      const slack = procedural || kinds.get(item.assetId) === 'anemone' ? 0.05 : 0;
      const [x0 = 0, , z0 = 0] = bounds.min;
      const [x1 = 0, , z1 = 0] = bounds.max;
      const cos = Math.cos(item.rotationY);
      const sin = Math.sin(item.rotationY);
      let reachX = 0;
      let reachZ = 0;
      for (const [x, z] of [
        [x0, z0],
        [x0, z1],
        [x1, z0],
        [x1, z1],
      ] as const) {
        reachX = Math.max(reachX, Math.abs(x * cos + z * sin));
        reachZ = Math.max(reachZ, Math.abs(-x * sin + z * cos));
      }
      expect(Math.abs(item.position[0]) + reachX * item.scale + slack, item.assetId).toBeLessThan(
        halfL,
      );
      expect(Math.abs(item.position[2]) + reachZ * item.scale + slack, item.assetId).toBeLessThan(
        halfD,
      );
    }
  });

  it('seats rocks, corals and the anemone on the substrate', () => {
    for (const item of preset.decor) {
      const kind = parseEuphylliaId(item.assetId) ? 'coral' : kinds.get(item.assetId);
      if (kind !== 'rock' && kind !== 'coral' && kind !== 'anemone') continue;
      const ground = substrateHeight(DEFAULT_TANK, item.position[0], item.position[2]);
      if (item.assetId === 'coast-rocks-05' && item.position[1] > ground + 0.05) continue;
      expect(Math.abs(item.position[1] - ground), item.assetId).toBeLessThan(0.03);
    }
  });
});

describe('loadPreset', () => {
  it('loads a preset for every biome', () => {
    expect(loadPreset('freshwater').biome).toBe('freshwater');
    expect(loadPreset('reef').biome).toBe('reef');
  });
});
