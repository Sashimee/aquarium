import { Basin, FlowField, waveMakerForTier } from '@aquarium/sim';
import { tankSpaceOf } from '../fish/demoStock';
import type { TankDimensions } from '../engine/tank/dimensions';

/**
 * The pump's flow as the scene samples it, in the same bounds the sim worker builds from the same
 * tank space. Null without a pump, and for one at speed 0, which `FlowField` rejects.
 */
export function pumpFieldFor(tier: number, tank: TankDimensions): FlowField | null {
  const settings = waveMakerForTier(tier);
  if (settings === null || settings.speedMps === 0) return null;
  const { minX, maxX, minZ, maxZ, minY, maxY } = Basin.fromSpace(tankSpaceOf(tank));
  return new FlowField({ minX, maxX, minZ, maxZ, minY, maxY }, settings);
}
