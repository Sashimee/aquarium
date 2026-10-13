import { describe, expect, it } from 'vitest';
import { coralGlow, coralTint, fluorescenceLevel, heightScale, placementKey } from './coralStyle';
import { loadPreset } from './preset';

describe('coral style', () => {
  it('wraps around the palette and keeps every channel at or below 1', () => {
    const tints = [0, 1, 2].map((i) => coralTint('brain-coral', i));
    expect(new Set(tints.map((t) => t?.getHex())).size).toBe(3);
    expect(coralTint('brain-coral', 3)?.getHex()).toBe(tints[0]?.getHex());
    for (const id of ['brain-coral', 'acropora-cytherea', 'acropora-palmata']) {
      for (let i = 0; i < 4; i++) {
        const c = coralTint(id, i);
        expect(Math.max(c?.r ?? 2, c?.g ?? 2, c?.b ?? 2)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps Acropora tints close to white so the baked colour shows through', () => {
    for (const id of ['acropora-cytherea', 'acropora-palmata']) {
      for (let i = 0; i < 2; i++) {
        const c = coralTint(id, i);
        expect(Math.min(c?.r ?? 0, c?.g ?? 0, c?.b ?? 0)).toBeGreaterThanOrEqual(0.7);
      }
    }
    expect(coralTint('acropora-palmata', 0)?.r).toBeCloseTo(1 - 0.62 * 0.35, 5);
  });

  it('leaves rock and unknown assets untinted and unsquashed', () => {
    expect(coralTint('boulder-01', 0)).toBeNull();
    expect(heightScale('boulder-01')).toBe(1);
    expect(heightScale('brain-coral')).toBeLessThan(1);
  });

  it('keys colour on the placement, not the layout order', () => {
    expect(placementKey([0.1, 0.05, 0.2], 1.5)).toBe(placementKey([0.1, 0.05, 0.2], 1.5));
    expect(placementKey([0.1, 0.05, 0.2], 1.5)).not.toBe(placementKey([0.2, 0.05, 0.2], 1.5));
  });

  it('colours the reef preset brain corals differently', () => {
    const hexes = loadPreset('reef')
      .decor.filter((d) => d.assetId === 'brain-coral')
      .map((d) => coralTint(d.assetId, placementKey(d.position, d.rotationY))?.getHex());
    expect(new Set(hexes).size).toBe(hexes.length);
  });
});

describe('coral fluorescence', () => {
  const corals = ['brain-coral', 'acropora-cytherea', 'acropora-palmata'];

  it('is absent in freshwater and on anything that is not a coral', () => {
    for (const id of corals) expect(coralGlow('freshwater', id, 0)).toBeNull();
    expect(coralGlow('reef', 'boulder-01', 0)).toBeNull();
  });

  it('gives each style its own green, orange or pink, wrapping with the placement key', () => {
    const glows = [0, 1, 2].map((i) => coralGlow('reef', 'brain-coral', i)?.getHex());
    expect(new Set(glows).size).toBe(3);
    expect(coralGlow('reef', 'brain-coral', 3)?.getHex()).toBe(glows[0]);
    const cytherea = [0, 1].map((i) => coralGlow('reef', 'acropora-cytherea', i)?.getHex());
    expect(cytherea[0]).not.toBe(cytherea[1]);
    for (const id of corals) {
      for (let i = 0; i < 4; i++) {
        const c = coralGlow('reef', id, i);
        expect(Math.max(c?.r ?? 2, c?.g ?? 2, c?.b ?? 2)).toBeLessThanOrEqual(1);
        expect(Math.max(c?.r ?? 0, c?.g ?? 0, c?.b ?? 0)).toBeGreaterThan(0.9);
      }
    }
  });

  it('follows the excitation: nothing without light, more by day than at night, never negative', () => {
    const day = fluorescenceLevel(3);
    const night = fluorescenceLevel(0.3);
    expect(fluorescenceLevel(0)).toBe(0);
    expect(fluorescenceLevel(-1)).toBe(0);
    expect(night).toBeGreaterThan(0);
    expect(day).toBeGreaterThan(night);
    expect(day / night).toBeLessThan(3 / 0.3);
  });
});
