import { describe, expect, it } from 'vitest';
import type { PresetLayout } from '@aquarium/shared';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { substrateHeight } from '../engine/tank/substrate';
import { TANK_SIZES } from '@aquarium/shared';
import { fitPresetToTank, footprintShare, MIN_PLANT_FIT, type BoundsOf } from './presetFit';

const boundsOf: BoundsOf = () => ({
  bounds: { min: [-0.2, 0, -0.2], max: [0.2, 0.1, 0.2] },
  swayReach: null,
});

describe('fitPresetToTank', () => {
  it('rests an item on the sand at the position the glass clamp moved it to', () => {
    const preset: PresetLayout = {
      id: 'test',
      name: 'test',
      biome: 'freshwater',
      plantPatches: [],
      decor: [
        {
          assetId: 'rock',
          position: [0, substrateHeight(DEFAULT_TANK, 0, 0.2), 0.2],
          rotationY: 0,
          scale: 1,
        },
      ],
    };
    const [item] = fitPresetToTank(preset, 'standard', DEFAULT_TANK, boundsOf, () => 0).decor;
    const [x, y, z] = item?.position ?? [0, 0, 0];
    expect(z).toBeLessThan(0.1);
    expect(y).toBeCloseTo(substrateHeight(DEFAULT_TANK, x, z), 10);
  });

  it('keeps a back-row patch of swaying plants at its authored depth', () => {
    const preset: PresetLayout = {
      id: 'test',
      name: 'test',
      biome: 'freshwater',
      plantPatches: [
        {
          id: 'back',
          assetId: 'weed',
          center: [0.1, -0.15],
          radius: 0.1,
          count: 16,
          scale: [0.6, 0.9],
          seed: 1,
        },
      ],
      decor: [],
    };
    const swaying = (scale: number) => 0.063 + 0.173 * scale;
    const std200 = { ...DEFAULT_TANK, length: 1, depth: 0.4 };
    const [patch] = fitPresetToTank(preset, 'std200', std200, boundsOf, (p) =>
      swaying(p.scale[1]),
    ).plantPatches;
    expect(patch?.center[1]).toBeLessThan(-0.07);
    expect(patch?.center[1]).toBeGreaterThanOrEqual((-0.15 * 0.4) / DEFAULT_TANK.depth);
  });

  describe('a smaller tank', () => {
    const preset: PresetLayout = {
      id: 'test',
      name: 'test',
      biome: 'freshwater',
      decor: [],
      plantPatches: [
        {
          id: 'carpet',
          assetId: 'weed',
          center: [0, 0],
          radius: 0.2,
          count: 70,
          scale: [0.7, 1],
          seed: 1,
        },
      ],
    };
    const nano = { ...DEFAULT_TANK, ...TANK_SIZES.nano30.dimensions };

    it('keeps plants near life size and plants fewer of them, in step with the floor area', () => {
      const [patch] = fitPresetToTank(preset, 'nano30', nano, boundsOf, () => 0).plantPatches;
      expect(footprintShare('nano30')).toBeCloseTo((0.4 / 1.2) * (0.25 / 0.5), 6);
      expect(patch?.scale[0]).toBeGreaterThanOrEqual(0.7 * MIN_PLANT_FIT - 1e-9);
      expect(patch?.scale[1]).toBeGreaterThanOrEqual(MIN_PLANT_FIT - 1e-9);
      expect(patch?.count).toBe(Math.round(70 * footprintShare('nano30')));
      expect(patch?.count).toBeLessThan(20);
    });

    it('keeps the authored patch on the standard tank and never grows past it', () => {
      const same = fitPresetToTank(preset, 'standard', DEFAULT_TANK, boundsOf, () => 0);
      expect(same.plantPatches).toEqual(preset.plantPatches);
      const long = { ...DEFAULT_TANK, ...TANK_SIZES.long300.dimensions };
      const [patch] = fitPresetToTank(preset, 'long300', long, boundsOf, () => 0).plantPatches;
      expect(patch?.count).toBeLessThanOrEqual(70);
    });
  });
});
