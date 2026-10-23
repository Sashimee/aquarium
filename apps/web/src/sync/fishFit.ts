import type { SpeciesSummary, TankSize } from '@aquarium/shared';

/**
 * Rounded down from the sim's `maxFishLengthM` for each tank's real sand. A table, not a call, so
 * the shop does not pull the whole sim into the initial bundle; fishFit.test.ts pins it to the sim.
 */
const MAX_FISH_LENGTH_M: Readonly<Record<TankSize, number>> = {
  nano30: 0.2168,
  standard: 0.3518,
  std200: 0.3643,
  long300: 0.3116,
};

export function tankMaxFishLengthM(size: TankSize): number {
  return MAX_FISH_LENGTH_M[size];
}

/** The sim cannot hold a fish longer than the tank allows, so a species that grows past it is refused up front. */
export function adultLengthRefusal(
  species: Pick<SpeciesSummary, 'commonName' | 'lifecycle'>,
  size: TankSize,
): string | undefined {
  const limitM = tankMaxFishLengthM(size);
  if (species.lifecycle.maxSizeM <= limitM) return undefined;
  return `${species.commonName} grows to ${Math.round(species.lifecycle.maxSizeM * 100)} cm, but this tank only holds fish up to ${Math.floor(limitM * 100)} cm. Choose a bigger tank.`;
}
