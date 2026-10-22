import { describe, expect, it } from 'vitest';
import { biomeSchema, TANK_SIZES, type Biome } from '@aquarium/shared';
import { Box3, Color, Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector3 } from 'three/webgpu';
import { float, vec4 } from 'three/tsl';
import { buildShaders, evaluate, type ShaderBackend } from '../shaderFixtures';
import { applyBiomeWater, BIOME_WATER } from './biomeWater';
import { Caustics } from './caustics';
import { spectralAbsorption, WaterMedium, type WaterQuality } from './medium';

const BIOMES: readonly Biome[] = biomeSchema.options;
const BOUNDS = new Box3(new Vector3(-0.59, 0.011, -0.24), new Vector3(0.59, 0.47, 0.24));
const LUMA = [0.2126, 0.7152, 0.0722] as const;
/** The sand of the standard tank lies about this far under the surface. */
const SAND_DEPTH = 0.4;

const medium = (quality: WaterQuality = BIOME_WATER.freshwater): WaterMedium =>
  new WaterMedium(BOUNDS, quality);

function extinction(biome: Biome): [number, number, number] {
  const { cdom440, turbidity } = BIOME_WATER[biome];
  const [r, g, b] = spectralAbsorption(cdom440);
  return [r + turbidity, g + turbidity, b + turbidity];
}

const transmittance = (biome: Biome, path: number): number[] =>
  extinction(biome).map((k) => Math.exp(-k * path));

/** The share of what scatters rather than absorbs, per channel: the colour of the haze. */
const albedo = (biome: Biome): number[] =>
  extinction(biome).map((k) => BIOME_WATER[biome].turbidity / k);

const photopic = (rgb: readonly number[]): number =>
  LUMA.reduce((sum, w, i) => sum + w * (rgb[i] ?? Number.NaN), 0);

function hoodAtSand(biome: Biome, depth = SAND_DEPTH): Color {
  return new Caustics(medium(BIOME_WATER[biome])).reachAtDepth(depth, new Color());
}

describe('BIOME_WATER for the original biomes', () => {
  // Freshwater and reef shipped before the biome table; their look must not move.
  it('keeps the freshwater water exactly as the engine default was', () => {
    expect(BIOME_WATER.freshwater).toEqual({ cdom440: 0.05, turbidity: 0.08 });
  });

  it('keeps the reef water exactly as the reef lighting set it', () => {
    expect(BIOME_WATER.reef).toEqual({ cdom440: 0.004, turbidity: 0.035 });
  });

  it('writes the same uniforms as the literal water did, bit for bit', () => {
    const literals: Record<'freshwater' | 'reef', WaterQuality> = {
      freshwater: { cdom440: 0.05, turbidity: 0.08 },
      reef: { cdom440: 0.004, turbidity: 0.035 },
    };
    for (const biome of ['freshwater', 'reef'] as const) {
      const before = medium(literals[biome]);
      const after = medium({ cdom440: 1, turbidity: 1 });
      applyBiomeWater(after, biome);
      expect(after.absorption.value.toArray()).toEqual(before.absorption.value.toArray());
      expect(after.scattering.value).toBe(before.scattering.value);
      expect(after.absorptionScale.value).toBe(before.absorptionScale.value);
    }
  });
});

describe('BIOME_WATER for the new biomes', () => {
  it('has a valid water for every biome', () => {
    for (const biome of BIOMES) {
      const water = BIOME_WATER[biome];
      expect(water.cdom440).toBeGreaterThanOrEqual(0);
      expect(water.turbidity).toBeGreaterThan(0);
      expect(() => medium(water)).not.toThrow();
    }
  });

  it('makes the cichlid lake clearer than the planted tank and blue-green', () => {
    const lake = extinction('cichlid');
    extinction('freshwater').forEach((k, i) => expect(lake[i]).toBeLessThan(k));
    const [r, g, b] = transmittance('cichlid', 1) as [number, number, number];
    expect(g).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(r);
    expect(BIOME_WATER.cichlid.cdom440).toBeLessThan(0.1);
  });

  it('stains blackwater tea-brown: blue goes first, then green, then red', () => {
    const [r, g, b] = transmittance('blackwater', 0.5) as [number, number, number];
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    const [ar, ag, ab] = albedo('blackwater') as [number, number, number];
    expect(ar).toBeGreaterThan(ag);
    expect(ag).toBeGreaterThan(ab);
  });

  it('gives blackwater lower visibility than the planted tank in every channel', () => {
    const tea = extinction('blackwater');
    extinction('freshwater').forEach((k, i) => expect(tea[i]).toBeGreaterThan(k));
  });

  it('absorbs more of the blue in blackwater the deeper the light goes', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const depth of [0, 0.1, 0.2, 0.3, 0.45]) {
      const light = hoodAtSand('blackwater', depth);
      const blueToRed = light.b / light.r;
      expect(blueToRed).toBeLessThan(previous);
      previous = blueToRed;
    }
    expect(previous).toBeLessThan(0.7);
  });

  it('warms the caustics on blackwater sand where the planted tank leaves them cool', () => {
    const tea = hoodAtSand('blackwater');
    const clear = hoodAtSand('freshwater');
    expect(tea.r).toBeGreaterThan(tea.g);
    expect(tea.g).toBeGreaterThan(tea.b);
    expect(clear.b).toBeGreaterThan(clear.r);
    expect(tea.r / tea.b).toBeGreaterThan((clear.r / clear.b) * 1.5);
  });

  it('makes the mangrove the haziest water, green-brown in its haze and its tint', () => {
    for (const biome of BIOMES) {
      if (biome !== 'mangrove') {
        expect(BIOME_WATER.mangrove.turbidity).toBeGreaterThan(BIOME_WATER[biome].turbidity);
      }
    }
    const [r, g, b] = transmittance('mangrove', 0.5) as [number, number, number];
    expect(g).toBeGreaterThan(r);
    expect(r).toBeGreaterThan(b);
    const [ar, ag, ab] = albedo('mangrove') as [number, number, number];
    expect(ag).toBeGreaterThan(ar);
    expect(ar).toBeGreaterThan(ab);
  });

  it('orders the biomes from reef to stained and turbid by how far one sees', () => {
    const k = (biome: Biome): number => photopic(extinction(biome));
    expect(k('reef')).toBeLessThan(k('cichlid'));
    expect(k('cichlid')).toBeLessThan(k('freshwater'));
    expect(k('freshwater')).toBeLessThan(k('blackwater'));
    expect(k('freshwater')).toBeLessThan(k('mangrove'));
  });

  it('still shows the far glass of the longest tank in every biome', () => {
    const longest = Math.max(...Object.values(TANK_SIZES).map((s) => s.dimensions.length));
    for (const biome of BIOMES) {
      expect(photopic(transmittance(biome, longest))).toBeGreaterThan(0.25);
    }
  });
});

describe('applyBiomeWater', () => {
  it('sets the medium to the biome and restores the previous water', () => {
    const water = medium({ cdom440: 0.3, turbidity: 0.2 });
    const restore = applyBiomeWater(water, 'blackwater');
    expect(water.getQuality()).toEqual(BIOME_WATER.blackwater);
    expect(water.absorption.value.toArray()).toEqual(spectralAbsorption(2.5));
    restore();
    expect(water.getQuality()).toEqual({ cdom440: 0.3, turbidity: 0.2 });
  });

  it('switches between biomes and back with the default restored', () => {
    const water = medium();
    for (const biome of BIOMES) {
      const restore = applyBiomeWater(water, biome);
      expect(water.scattering.value).toBe(BIOME_WATER[biome].turbidity);
      restore();
      expect(water.getQuality()).toEqual(BIOME_WATER.freshwater);
    }
  });

  it('feeds the shader graph: the evaluated transmittance follows the biome', () => {
    const water = medium();
    for (const biome of BIOMES) {
      applyBiomeWater(water, biome);
      const gpu = evaluate(water.transmittance(float(0.5)));
      expect(gpu).toHaveLength(3);
      gpu.forEach((v, i) => expect(v).toBeCloseTo(transmittance(biome, 0.5)[i] ?? Number.NaN, 12));
    }
  });
});

describe('biome water on both backends', () => {
  function fogShader(water: WaterMedium, backend: ShaderBackend): string {
    const material = new MeshBasicNodeMaterial();
    material.outputNode = water.applyPremultiplied(vec4(0.5, 0.5, 0.5, 1));
    return buildShaders(new Mesh(new PlaneGeometry(), material), backend).fragment;
  }

  // The biome is uniforms only: one pipeline serves every biome, so a tank switch compiles nothing
  // and the frame cost of every tier is the one it had.
  for (const backend of ['webgpu', 'webgl'] as const) {
    it(`builds one identical ${backend} water shader for every biome`, () => {
      const water = medium();
      const shaders = BIOMES.map((biome) => {
        applyBiomeWater(water, biome);
        return fogShader(water, backend);
      });
      expect(shaders[0]?.length).toBeGreaterThan(0);
      for (const shader of shaders) expect(shader).toBe(shaders[0]);
    });
  }

  it('builds the WebGL 2 fallback in GLSL with the exponential absorption', () => {
    const fragment = fogShader(medium(BIOME_WATER.blackwater), 'webgl');
    expect(fragment).toMatch(/#version 300 es/);
    expect(fragment).toMatch(/\bexp\(/);
  });
});
