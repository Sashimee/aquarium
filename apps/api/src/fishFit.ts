import { tankSpaceOfSize, type TankSize } from '@aquarium/shared';
import { maxFishLengthM } from '@aquarium/sim';

const limits = new Map<TankSize, number>();

export function tankMaxFishLengthM(size: TankSize): number {
  let limit = limits.get(size);
  if (limit === undefined) {
    limit = maxFishLengthM(tankSpaceOfSize(size));
    limits.set(size, limit);
  }
  return limit;
}

/** The sim cannot hold a fish longer than the tank allows, so a species that grows past it is refused up front. */
export function adultLengthRefusal(
  species: { commonName: string; lifecycle: { maxSizeM: number } },
  size: TankSize,
): string | undefined {
  const limitM = tankMaxFishLengthM(size);
  if (species.lifecycle.maxSizeM <= limitM) return undefined;
  return `${species.commonName} grows to ${Math.round(species.lifecycle.maxSizeM * 100)} cm, but this tank only holds fish up to ${Math.floor(limitM * 100)} cm. Choose a bigger tank.`;
}
