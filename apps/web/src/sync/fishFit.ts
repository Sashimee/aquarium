import type { SpeciesSummary, TankSize } from '@aquarium/shared';
import { maxFishLengthM } from '@aquarium/sim';
import { tankSpaceOf } from '../fish/demoStock';
import { TANK_DIMENSIONS } from '../engine/tank/dimensions';

export function tankMaxFishLengthM(size: TankSize): number {
  return maxFishLengthM(tankSpaceOf(TANK_DIMENSIONS[size]));
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
