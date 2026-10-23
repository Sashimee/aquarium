import type { Biome } from '@aquarium/shared';
import type { WaterMedium, WaterQuality } from './medium';

/**
 * The water in each biome's tank, as CDOM absorption at 440 nm and particle scattering (1/m).
 * These are aquarium waters, filtered and changed, so each sits at the clear end of its wild
 * habitat's range. The colour, the loss of visibility and the tint of the caustics all follow
 * from these two numbers through `WaterMedium` and `Caustics`, so a biome costs no shader work.
 */
export const BIOME_WATER: Readonly<Record<Biome, Readonly<WaterQuality>>> = Object.freeze({
  freshwater: Object.freeze({ cdom440: 0.05, turbidity: 0.08 }),
  reef: Object.freeze({ cdom440: 0.004, turbidity: 0.035 }),
  // The Rift lakes are oligotrophic with very little humic matter (Bootsma & Hecky 2003), so only
  // pure water's red loss tints them; clearer than the planted tank, short of the reef.
  cichlid: Object.freeze({ cdom440: 0.02, turbidity: 0.05 }),
  // Humic waters run from a few tenths to tens of 1/m (Kirk 2011); a leaf- and peat-steeped tank
  // is a fraction of the Rio Negro's. At 2.5 the blue is gone first and the green before the red,
  // which is tea; the scattering stays low because blackwater carries little sediment (Sioli 1984).
  blackwater: Object.freeze({ cdom440: 2.5, turbidity: 0.1 }),
  // Mangrove leaf leachate stains brackish creeks, and tide-stirred silt keeps them turbid. Both
  // numbers are estimates, not measurements: no mangrove-specific CDOM or scattering survey backs
  // them. They are placed for the look: less CDOM than blackwater, so green outlasts red, under a
  // haze stronger than any other biome's.
  mangrove: Object.freeze({ cdom440: 0.8, turbidity: 0.5 }),
});

/** Sets the biome's water on `medium` and returns a function that restores the previous water. */
export function applyBiomeWater(medium: WaterMedium, biome: Biome): () => void {
  const previous = medium.getQuality();
  medium.setQuality(BIOME_WATER[biome]);
  return () => medium.setQuality(previous);
}
