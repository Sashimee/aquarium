import { describe, expect, it } from 'vitest';
import { Box3, Color, Vector3 } from 'three/webgpu';
import { Caustics, castingShare, causticContrast } from './caustics';
import { WaterMedium } from './medium';

const DARK_SAND = 0.08;
const REEF_SAND = 0.68;

function caustics(): Caustics {
  const medium = new WaterMedium(new Box3(new Vector3(-0.5, 0, -0.2), new Vector3(0.5, 0.5, 0.2)), {
    cdom440: 0,
    turbidity: 0.1,
  });
  return new Caustics(medium);
}

describe('castingShare', () => {
  it('is exactly zero with the main channel off, whatever the moonlight', () => {
    expect(castingShare(0, 0.12)).toBe(0);
    expect(castingShare(0, 0)).toBe(0);
  });

  it('is one with only the main channel on', () => {
    expect(castingShare(3.9, 3.9)).toBe(1);
  });

  it('falls through dusk, as the moonlight takes over', () => {
    const dusk = [1, 0.5, 0.1, 0.01].map((day) => {
      const main = 3.9 * day;
      return castingShare(main, main + 0.12 * (1 - day));
    });
    expect([...dusk].sort((a, b) => b - a)).toEqual(dusk);
    expect(new Set(dusk).size).toBe(dusk.length);
    expect(dusk[3]).toBeLessThan(0.3);
  });
});

describe('causticContrast', () => {
  it('is zero when nothing casts caustics', () => {
    expect(causticContrast(0.6, 0, DARK_SAND)).toBe(0);
  });

  it('is the full strength in daylight on dark sand', () => {
    expect(causticContrast(0.6, 1, DARK_SAND)).toBeCloseTo(0.6, 10);
  });

  it('is lower on bright reef sand, so the net does not dominate the frame', () => {
    const reef = causticContrast(0.6, 1, REEF_SAND);
    expect(reef).toBeLessThan(0.5 * causticContrast(0.6, 1, DARK_SAND));
    expect(reef).toBeGreaterThan(0);
  });

  it('never exceeds the strength on very dark substrate', () => {
    expect(causticContrast(0.6, 1, 0)).toBeCloseTo(0.6, 10);
  });
});

describe('Caustics.updateContrast', () => {
  const darkSand = new Color(0.13, 0.09, 0.055);
  const moonlight = new Color(0.04, 0.14, 0.9);

  it('is the main channel share of the hood light, zero with only the moonlight on', () => {
    const c = caustics();
    const main = new Color(4, 3.9, 3.7);
    c.lightRadiance.value.copy(main);
    c.updateContrast(main, darkSand);
    expect(c.contrast.value).toBeCloseTo(c.strength.value, 10);
    expect(c.castingShare.value).toBe(1);

    c.lightRadiance.value.copy(moonlight);
    c.updateContrast(new Color(0, 0, 0), darkSand);
    expect(c.contrast.value).toBe(0);
    expect(c.castingShare.value).toBe(0);

    c.lightRadiance.value.copy(main).multiplyScalar(0.05).add(moonlight);
    c.updateContrast(main.clone().multiplyScalar(0.05), darkSand);
    expect(c.contrast.value).toBeGreaterThan(0);
    expect(c.contrast.value).toBeLessThan(c.strength.value);
  });

  it('reduces only the surface contrast on bright sand, not the casting share', () => {
    const c = caustics();
    c.lightRadiance.value.setRGB(4, 3.9, 3.7);
    c.updateContrast(c.lightRadiance.value, new Color(0.75, 0.7, 0.6));
    expect(c.castingShare.value).toBe(1);
    expect(c.contrast.value).toBeLessThan(0.5 * c.strength.value);
  });

  it('follows changes to the strength from the dev panel', () => {
    const c = caustics();
    c.strength.value = 0.3;
    c.lightRadiance.value.setRGB(4, 3.9, 3.7);
    c.updateContrast(c.lightRadiance.value, darkSand);
    expect(c.contrast.value).toBeCloseTo(0.3, 10);
  });
});
