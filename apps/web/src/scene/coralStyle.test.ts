import { describe, expect, it } from 'vitest';
import { coralTint, heightScale } from './coralStyle';

describe('coral style', () => {
  it('gives successive brain corals different tints and wraps around the palette', () => {
    const tints = [0, 1, 2].map((i) => coralTint('brain-coral', i)?.getHex());
    expect(new Set(tints).size).toBe(3);
    expect(coralTint('brain-coral', 3)?.getHex()).toBe(tints[0]);
  });

  it('leaves rock and unknown assets untinted and unsquashed', () => {
    expect(coralTint('boulder-01', 0)).toBeNull();
    expect(heightScale('boulder-01')).toBe(1);
    expect(heightScale('brain-coral')).toBeLessThan(1);
  });
});
