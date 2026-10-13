import { describe, expect, it } from 'vitest';
import { Box3, Color, Texture, Vector3 } from 'three/webgpu';
import { Caustics } from './caustics';
import { InteriorLight } from './interior';
import { WaterMedium } from './medium';

const SURFACE = 0.5;

function setup(sandHeight = 0.1) {
  const medium = new WaterMedium(
    new Box3(new Vector3(-0.5, 0, -0.2), new Vector3(0.5, SURFACE, 0.2)),
    {
      cdom440: 0,
      turbidity: 0.1,
    },
  );
  const caustics = new Caustics(medium);
  caustics.lightRadiance.value.setRGB(2, 2, 2);
  const albedo = new Color(0.5, 0.5, 0.5);
  const interior = new InteriorLight(medium, caustics, new Texture(), albedo, sandHeight);
  return { medium, caustics, albedo, interior };
}

describe('Caustics.hoodLightAtDepth', () => {
  it('is the hood radiance itself at and above the surface', () => {
    const { caustics } = setup();
    const out = new Color();
    expect(caustics.hoodLightAtDepth(0, out).toArray()).toEqual([2, 2, 2]);
    expect(caustics.hoodLightAtDepth(-0.1, out).toArray()).toEqual([2, 2, 2]);
  });

  it('spreads and absorbs with depth, red first', () => {
    const { medium, caustics } = setup();
    const depth = 0.4;
    const light = caustics.hoodLightAtDepth(depth, new Color());
    const h = medium.fixtureHeight.value;
    const spread = (h / (h + depth)) ** 2;
    const [ar, , ab] = medium.absorption.value.toArray();
    expect(light.r).toBeCloseTo(2 * spread * Math.exp(-(ar + 0.1) * depth), 6);
    expect(light.b).toBeCloseTo(2 * spread * Math.exp(-(ab + 0.1) * depth), 6);
    expect(light.r).toBeLessThan(light.g);
    expect(light.g).toBeLessThan(light.b);
  });

  it('lengthens the path for a slanted light, but not past a grazing limit', () => {
    const { caustics } = setup();
    const overhead = caustics.hoodLightAtDepth(0.4, new Color()).r;
    caustics.lightDirection.value.set(1, 1, 0).normalize();
    const slanted = caustics.hoodLightAtDepth(0.4, new Color()).r;
    caustics.lightDirection.value.set(1, 0.05, 0).normalize();
    const grazing = caustics.hoodLightAtDepth(0.4, new Color()).r;
    caustics.lightDirection.value.set(0, -1, 0);
    const below = caustics.hoodLightAtDepth(0.4, new Color()).r;
    expect(slanted).toBeLessThan(overhead);
    expect(grazing).toBeLessThan(slanted);
    expect(grazing).toBeGreaterThan(0);
    expect(below).toBe(grazing);
  });
});

describe('InteriorLight.update', () => {
  it('throws back the hood light at the sand, coloured by the substrate', () => {
    const { caustics, interior } = setup(0.1);
    interior.update();
    const atSand = caustics.hoodLightAtDepth(SURFACE - 0.1, new Color());
    const expected = atSand.multiplyScalar(0.5 * (0.5 / Math.PI));
    expect(interior.substrateBounce.value.r).toBeCloseTo(expected.r, 9);
    expect(interior.substrateBounce.value.b).toBeCloseTo(expected.b, 9);
  });

  it('is brighter for higher sand, which sits nearer the hood', () => {
    const low = setup(0.01);
    const high = setup(0.1);
    low.interior.update();
    high.interior.update();
    expect(high.interior.substrateBounce.value.g).toBeGreaterThan(
      low.interior.substrateBounce.value.g,
    );
  });

  it('follows later changes to the albedo, the hood and the water', () => {
    const { medium, caustics, albedo, interior } = setup();
    interior.update();
    const before = interior.substrateBounce.value.clone();

    albedo.setRGB(1, 0.5, 0.5);
    interior.update();
    expect(interior.substrateBounce.value.r).toBeCloseTo(before.r * 2, 9);
    expect(interior.substrateAlbedo.value).toBe(albedo);

    caustics.lightRadiance.value.setRGB(0, 0, 0);
    interior.update();
    expect(interior.substrateBounce.value.toArray()).toEqual([0, 0, 0]);

    caustics.lightRadiance.value.setRGB(2, 2, 2);
    albedo.setRGB(0.5, 0.5, 0.5);
    medium.setQuality({ cdom440: 0.5, turbidity: 0.1 });
    interior.update();
    expect(interior.substrateBounce.value.b).toBeLessThan(before.b);
  });
});
