import { describe, expect, it } from 'vitest';
import { legacyTintSeed, type DecorItem } from './common.js';
import { fitPresetItem, presetFit } from './presetFit.js';

const item: DecorItem = {
  assetId: 'boulder-01',
  position: [0.6, 0.1, -0.25],
  rotationY: 0,
  scale: 1,
};

describe('presetFit', () => {
  it('leaves the standard tank as authored', () => {
    expect(presetFit('standard')).toEqual({ lengthRatio: 1, depthRatio: 1, scale: 1 });
    expect(fitPresetItem(item, 'standard')).toEqual({ ...item, tintSeed: legacyTintSeed(item) });
  });

  it('shrinks the nano tank by its length and depth', () => {
    const fit = presetFit('nano30');
    expect(fit.lengthRatio).toBeCloseTo(0.4 / 1.2, 9);
    expect(fit.depthRatio).toBeCloseTo(0.25 / 0.5, 9);
    expect(fit.scale).toBeCloseTo(0.4 / 1.2, 9);
    const fitted = fitPresetItem(item, 'nano30');
    expect(fitted.position[0]).toBeCloseTo(0.2, 9);
    expect(fitted.position[2]).toBeCloseTo(-0.125, 9);
    expect(fitted.scale).toBeCloseTo(1 / 3, 9);
  });

  it('stretches positions along a long tank without growing sizes', () => {
    const fit = presetFit('long300');
    expect(fit.lengthRatio).toBeCloseTo(1.25, 9);
    expect(fit.depthRatio).toBeCloseTo(0.9, 9);
    expect(fit.scale).toBeCloseTo(0.9, 9);
    expect(fitPresetItem(item, 'long300').position[0]).toBeCloseTo(0.75, 9);
  });

  it.each(['nano30', 'std200', 'long300'] as const)(
    'names an item by its authored seed on %s',
    (size) => {
      expect(fitPresetItem(item, size).tintSeed).toBe(legacyTintSeed(item));
      expect(fitPresetItem({ ...item, tintSeed: 5 }, size).tintSeed).toBe(5);
    },
  );
});
