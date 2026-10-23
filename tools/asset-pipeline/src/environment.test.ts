import { describe, expect, it } from 'vitest';
import { varyLeafColour } from './environment.ts';

describe('varyLeafColour', () => {
  const base: [number, number, number, number] = [0.55, 0.76, 0.29, 1];
  const variation = { spread: 0.14, yellowing: 0.1 };

  it('is deterministic and differs between leaves', () => {
    expect(varyLeafColour(base, 3, variation)).toEqual(varyLeafColour(base, 3, variation));
    const shades = new Set(
      Array.from({ length: 24 }, (_, i) => varyLeafColour(base, i, variation).join()),
    );
    expect(shades.size).toBe(24);
  });

  it('stays within the spread and keeps alpha', () => {
    for (let i = 0; i < 24; i++) {
      const [, g, , a] = varyLeafColour(base, i, variation);
      expect(g).toBeGreaterThanOrEqual(base[1] * 0.86 - 1e-9);
      expect(g).toBeLessThanOrEqual(base[1] * 1.14 + 1e-9);
      expect(a).toBe(1);
    }
  });

  it('changes nothing with zero spread and zero yellowing', () => {
    expect(varyLeafColour(base, 5, { spread: 0, yellowing: 0 })).toEqual(base);
  });
});
