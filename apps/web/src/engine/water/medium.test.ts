import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three/webgpu';
import { spectralAbsorption, WaterMedium } from './medium';

describe('spectralAbsorption', () => {
  it('pure water absorbs red most and blue least', () => {
    const [r, g, b] = spectralAbsorption(0);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(r).toBeCloseTo(0.264, 3);
  });

  it('CDOM adds absorption that is strongest towards blue', () => {
    const clear = spectralAbsorption(0);
    const tannin = spectralAbsorption(0.5);
    const added = tannin.map((v, i) => v - (clear[i] ?? 0));
    const [dr, dg, db] = added as [number, number, number];
    expect(db).toBeGreaterThan(dg);
    expect(dg).toBeGreaterThan(dr);
    // a(465 nm) = a440 * exp(-0.014 * 25)
    expect(db).toBeCloseTo(0.5 * Math.exp(-0.014 * 25), 6);
  });
});

describe('WaterMedium', () => {
  const bounds = new Box3(new Vector3(-0.5, 0, -0.2), new Vector3(0.5, 0.4, 0.2));

  it('rejects empty bounds and negative water quality', () => {
    expect(() => new WaterMedium(new Box3(), { cdom440: 0, turbidity: 0 })).toThrow(/empty/);
    expect(() => new WaterMedium(bounds, { cdom440: -1, turbidity: 0 })).toThrow(RangeError);
    expect(() => new WaterMedium(bounds, { cdom440: 0, turbidity: Number.NaN })).toThrow(
      RangeError,
    );
  });

  it('writes bounds and water quality into its uniforms', () => {
    const medium = new WaterMedium(bounds, { cdom440: 0.2, turbidity: 0.3 });
    expect(medium.boxMin.value.toArray()).toEqual([-0.5, 0, -0.2]);
    expect(medium.boxMax.value.toArray()).toEqual([0.5, 0.4, 0.2]);
    expect(medium.absorption.value.toArray()).toEqual(spectralAbsorption(0.2));
    expect(medium.scattering.value).toBe(0.3);
    medium.setQuality({ cdom440: 0, turbidity: 0.05 });
    expect(medium.getQuality()).toEqual({ cdom440: 0, turbidity: 0.05 });
    expect(medium.absorption.value.toArray()).toEqual(spectralAbsorption(0));
  });
});
