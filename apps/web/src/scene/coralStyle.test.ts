import { describe, expect, it } from 'vitest';
import { coralTint, heightScale, placementKey } from './coralStyle';
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
