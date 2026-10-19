import { describe, expect, it } from 'vitest';
import type { PresetLayout } from '@aquarium/shared';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { substrateHeight } from '../engine/tank/substrate';
import { fitPresetToTank, type BoundsOf } from './presetFit';

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
    const [item] = fitPresetToTank(preset, DEFAULT_TANK, boundsOf, () => 0).decor;
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
    const [patch] = fitPresetToTank(preset, std200, boundsOf, (p) =>
      swaying(p.scale[1]),
    ).plantPatches;
    expect(patch?.center[1]).toBeLessThan(-0.07);
    expect(patch?.center[1]).toBeGreaterThanOrEqual((-0.15 * 0.4) / DEFAULT_TANK.depth);
  });
});
