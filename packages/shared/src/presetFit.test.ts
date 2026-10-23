import { describe, expect, it } from 'vitest';
import { legacyTintSeed, type DecorItem } from './common.js';
import {
  DECOR_MIN_SCALE,
  fitPresetDecor,
  fitPresetItem,
  keptPresetDecor,
  presetDecorCount,
  presetFit,
} from './presetFit.js';

const item: DecorItem = {
  assetId: 'boulder-01',
  position: [0.6, 0.1, -0.25],
  rotationY: 0,
  scale: 1,
};

describe('presetFit', () => {
  it('leaves the standard tank as authored', () => {
    expect(presetFit('standard')).toEqual({
      lengthRatio: 1,
      depthRatio: 1,
      scale: 1,
      decorScale: 1,
      decorShare: 1,
    });
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

  it('keeps a perch at its authored scale while still stretching its position', () => {
    const perch: DecorItem = { ...item, assetId: 'mangrove-stump', scale: 1.4, perch: true };
    const fitted = fitPresetItem(perch, 'nano30');
    expect(fitted.scale).toBe(1.4);
    expect(fitted.perch).toBe(true);
    expect(fitted.position[0]).toBeCloseTo(0.2, 9);
  });

  it('keeps decor at its minimum scale where the tank is smaller still', () => {
    expect(presetFit('nano30').decorScale).toBe(DECOR_MIN_SCALE);
    expect(presetFit('std200').decorScale).toBeCloseTo(0.8, 9);
    expect(fitPresetDecor([{ ...item, scale: 2 }], 'nano30')[0]?.scale).toBeCloseTo(1.2, 9);
    expect(fitPresetDecor([{ ...item, scale: 2, perch: true }], 'nano30')[0]?.scale).toBe(2);
  });

  it('drops decor only where the floor cannot hold it', () => {
    expect(presetFit('nano30').decorShare).toBeCloseTo(0.4 / 1.2 / 2 / 0.36, 9);
    for (const size of ['standard', 'std200', 'long300'] as const) {
      expect(presetFit(size).decorShare, size).toBe(1);
      expect(presetDecorCount(16, size), size).toBe(16);
    }
    expect(presetDecorCount(16, 'nano30')).toBe(8);
    expect(presetDecorCount(8, 'nano30')).toBe(4);
    expect(presetDecorCount(1, 'nano30')).toBe(1);
    expect(presetDecorCount(0, 'nano30')).toBe(0);
  });

  it('keeps the head of the list and fits it the way fitPresetItem does', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ ...item, scale: 1 + i / 10 }));
    expect(keptPresetDecor(items, 'nano30')).toEqual(items.slice(0, 4));
    const fitted = fitPresetDecor(items, 'nano30');
    expect(fitted.map((it) => it.position)).toEqual(
      items.slice(0, 4).map((it) => fitPresetItem(it, 'nano30').position),
    );
    expect(fitted.map((it) => it.tintSeed)).toEqual(
      items.slice(0, 4).map((it) => legacyTintSeed(it)),
    );
    expect(fitPresetDecor(items, 'standard')).toHaveLength(8);
  });
});
