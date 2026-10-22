import type { Biome } from '@aquarium/shared';
import type { Engine } from '../engine/Engine';
import { applyBiomeWater } from '../engine/water/biomeWater';

interface Lighting {
  readonly hoodColor: readonly [number, number, number];
  readonly hoodIntensity: number;
  readonly ambientScatter: readonly [number, number, number];
  /** Mean linear albedo of the biome's substrate. */
  readonly substrateAlbedo: readonly [number, number, number];
  /** See `InteriorLight.fill`. */
  readonly fillLevel: number;
}

/**
 * A reef LED: 20 000 K white plus actinic 420-450 nm channels (linear sRGB). Freshwater keeps the
 * engine defaults, so it has no entry; every biome's water comes from `BIOME_WATER`.
 */
const BIOME_LIGHTING: Readonly<Partial<Record<Biome, Lighting>>> = {
  reef: {
    hoodColor: [0.32, 0.45, 1],
    hoodIntensity: 7,
    ambientScatter: [0.008, 0.026, 0.05],
    substrateAlbedo: [0.78, 0.68, 0.46],
    // The bright sand already throws back about a third of the hood's light at the floor into the
    // shadows, against a twentieth from the dark freshwater sand, so the reef needs no fill.
    fillLevel: 0,
  },
};

/** Applies the biome's lighting to the engine and returns a function that restores the previous one. */
export function applyBiomeLighting(engine: Engine, biome: Biome): () => void {
  const restoreWater = applyBiomeWater(engine.medium, biome);
  const lighting = BIOME_LIGHTING[biome];
  if (!lighting) return restoreWater;

  const { hood, ambientScatter, substrateAlbedo, interior } = engine;
  const previous = {
    colour: hood.color.clone(),
    intensity: hood.intensity,
    ambientScatter: ambientScatter.clone(),
    substrateAlbedo: substrateAlbedo.clone(),
    fillLevel: interior.fillLevel,
  };
  hood.color.setRGB(...lighting.hoodColor);
  hood.intensity = lighting.hoodIntensity;
  ambientScatter.setRGB(...lighting.ambientScatter);
  substrateAlbedo.setRGB(...lighting.substrateAlbedo);
  interior.fillLevel = lighting.fillLevel;

  return () => {
    hood.color.copy(previous.colour);
    hood.intensity = previous.intensity;
    restoreWater();
    ambientScatter.copy(previous.ambientScatter);
    substrateAlbedo.copy(previous.substrateAlbedo);
    interior.fillLevel = previous.fillLevel;
  };
}
