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
});
