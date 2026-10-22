import { compileCollider } from '@aquarium/sim';
import type { Collider, DecorItem } from '@aquarium/shared';
import { placedShelterParts } from '../../scene/shelterParts';

/** A mouth deeper in a collider than this share of its radius is not a place a fish can sit. */
export const BLOCKED_MOUTH_CLEARANCE = 0.5;

/** The piece's convex parts placed in the tank, with ids `<colliderId>.0`, `.1`, ... */
export function shelterColliders(colliderId: string, item: DecorItem): Collider[] {
  return placedShelterParts(item).map((vertices, i) => ({
    id: `${colliderId}.${i}`,
    hard: true,
    kind: 'hull',
    vertices,
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
