import { adultLengthRefusalText, tankSpaceOfSize, type TankSize } from '@aquarium/shared';
import { maxFishLengthM } from '@aquarium/sim';

const limits = new Map<TankSize, number>();

/**
 * The sim refuses a fish at or past `maxFishLengthM`, so the limit is that value rounded down to
 * 0.1 mm: strictly below it, and the same table the shop uses. Migration 0034 holds the same numbers.
 */
export function tankMaxFishLengthM(size: TankSize): number {
  let limit = limits.get(size);
  if (limit === undefined) {
    limit = Math.floor(maxFishLengthM(tankSpaceOfSize(size)) * 1e4) / 1e4;
    limits.set(size, limit);
  }
  return limit;
}

/** The sim cannot hold a fish longer than the tank allows, so a species that grows past it is refused up front. */
export function adultLengthRefusal(
  species: { commonName: string; lifecycle: { maxSizeM: number } },
  tank: { size: TankSize; quarantine: boolean },
): string | undefined {
  const limitM = tankMaxFishLengthM(tank.size);
  if (species.lifecycle.maxSizeM <= limitM) return undefined;
  return adultLengthRefusalText(species, limitM, tank.quarantine);
}
