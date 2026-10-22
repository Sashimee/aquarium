import { compileCollider } from '@aquarium/sim';
import type { Collider, DecorItem, Point3 } from '@aquarium/shared';
import { heightScale } from '../../scene/coralStyle';
import { SHELTER_PARTS } from './shelterParts';

/** A mouth deeper in a collider than this share of its radius is not a place a fish can sit. */
export const BLOCKED_MOUTH_CLEARANCE = 0.5;

export function hasShelterParts(assetId: string): boolean {
  return assetId in SHELTER_PARTS;
}

/** The piece's convex parts placed in the tank, with ids `<colliderId>.0`, `.1`, ... */
export function shelterColliders(colliderId: string, item: DecorItem): Collider[] {
  const parts = SHELTER_PARTS[item.assetId];
  if (!parts) throw new Error(`"${item.assetId}" has no shelter parts; add it to SHELTER_PARTS`);
  const sy = item.scale * heightScale(item.assetId);
  const cos = Math.cos(item.rotationY);
  const sin = Math.sin(item.rotationY);
  return parts.map((part, i) => ({
    id: `${colliderId}.${i}`,
    hard: true,
    kind: 'hull',
    vertices: Array.from({ length: part.length / 3 }, (_, k): Point3 => {
      const lx = (part[k * 3] ?? 0) * item.scale;
      const lz = (part[k * 3 + 2] ?? 0) * item.scale;
      return [
        item.position[0] + lx * cos + lz * sin,
        item.position[1] + (part[k * 3 + 1] ?? 0) * sy,
        item.position[2] - lx * sin + lz * cos,
      ];
    }),
  }));
}

export interface MouthLike {
  readonly id: string;
  readonly position: readonly [number, number, number];
  readonly radius: number;
}

/**
 * Ids of the mouths that sit inside solid decor, such as one a player has packed a rock against.
 * A fish sent there would shelter in front of the rock instead of in the cave.
 */
export function blockedMouths(
  mouths: readonly MouthLike[],
  colliders: readonly Collider[],
): string[] {
  const solids = colliders.filter((c) => c.hard).map(compileCollider);
  const normal = new Float64Array(3);
  return mouths
    .filter((m) => {
      const [x, y, z] = m.position;
      const clearance = Math.min(...solids.map((s) => s.sample(x, y, z, normal)));
      return clearance < BLOCKED_MOUTH_CLEARANCE * m.radius;
    })
    .map((m) => m.id);
}
