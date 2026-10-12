import type { Biome } from '@aquarium/shared';
import type { Engine } from '../engine/Engine';
import type { WaterQuality } from '../engine/water/medium';

interface Lighting {
  readonly hoodColor: readonly [number, number, number];
  readonly hoodIntensity: number;
  readonly water: WaterQuality;
  readonly ambientScatter: readonly [number, number, number];
}

/**
 * A metal-halide / LED reef blend near 14 000 K over very clear, tannin-free water. Freshwater
 * keeps the engine defaults, so it has no entry.
 */
const BIOME_LIGHTING: Readonly<Partial<Record<Biome, Lighting>>> = {
  reef: {
    hoodColor: [0.74, 0.86, 1],
    hoodIntensity: 3.4,
    water: { cdom440: 0.004, turbidity: 0.035 },
    ambientScatter: [0.008, 0.026, 0.05],
  },
};

/** Applies the biome's lighting to the engine and returns a function that restores the previous one. */
export function applyBiomeLighting(engine: Engine, biome: Biome): () => void {
  const lighting = BIOME_LIGHTING[biome];
  if (!lighting) return () => undefined;

  const { hood, medium, ambientScatter } = engine;
  const previous = {
    colour: hood.color.clone(),
    intensity: hood.intensity,
    water: medium.getQuality(),
    ambientScatter: ambientScatter.clone(),
  };
  hood.color.setRGB(...lighting.hoodColor);
  hood.intensity = lighting.hoodIntensity;
  medium.setQuality(lighting.water);
  ambientScatter.setRGB(...lighting.ambientScatter);

  return () => {
    hood.color.copy(previous.colour);
    hood.intensity = previous.intensity;
    medium.setQuality(previous.water);
    ambientScatter.copy(previous.ambientScatter);
  };
}
