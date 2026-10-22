import { Vector3 } from 'three/webgpu';
import type { DecorItem } from '@aquarium/shared';
import type { SceneAnchor } from './anemone';
import { decorMatrix } from './hardscape';

/** A shelter's mouth in the asset's own frame (origin at the base centre, metres at scale 1). */
interface CaveMouth {
  readonly position: readonly [number, number, number];
  readonly facing: readonly [number, number, number];
  readonly radius: number;
}

/**
 * Where the opening sits and which way it looks out. A shelter is solid to the sim: the scene fits
 * one convex hull to it, and the decor layer replaces that with a rounded box over its whole
 * footprint. The mouth is set outside both along `facing`, at least its own `radius` clear, where
 * a fish can reach it.
 */
export const CAVE_MOUTHS: Readonly<Record<string, CaveMouth>> = {
  'reef-arch': { position: [0.005, 0.03, 0.09], facing: [0, 0, 1], radius: 0.025 },
  'rock-pile-cave': { position: [0, 0.055, 0.2], facing: [0, 0, 1], radius: 0.035 },
  'rock-pile-stack': { position: [0.11, 0.04, 0.215], facing: [0, 0, 1], radius: 0.025 },
  'neothauma-shell': { position: [0, 0.013, 0.04], facing: [0, 0, 1], radius: 0.012 },
};

export function offersShelter(assetId: string): boolean {
  return assetId in CAVE_MOUTHS;
}

export function caveAnchor(id: string, item: DecorItem): SceneAnchor {
  const mouth = CAVE_MOUTHS[item.assetId];
  if (!mouth) throw new Error(`"${item.assetId}" has no cave mouth; add it to CAVE_MOUTHS`);
  const position = new Vector3(...mouth.position).applyMatrix4(decorMatrix(item));
  const [fx, fy, fz] = mouth.facing;
  const cos = Math.cos(item.rotationY);
  const sin = Math.sin(item.rotationY);
  return {
    id,
    kind: 'cave',
    position: [position.x, position.y, position.z],
    radius: mouth.radius * item.scale,
    facing: [fx * cos + fz * sin, fy, -fx * sin + fz * cos],
  };
}

/** Half-extents, in x and z, of the water the sim lets an anchor sit in. */
export interface WaterReach {
  readonly halfX: number;
  readonly halfZ: number;
}

/**
 * A mouth that falls outside the water, as one facing the glass of a rock set close to it does, has
 * no place a fish can reach and the sim refuses it, so it is left out. Ids stay tied to the
 * shelter's place in the list, so dropping one does not renumber the rest.
 */
export function caveAnchors(items: readonly DecorItem[], water?: WaterReach): SceneAnchor[] {
  return items
    .filter((item) => offersShelter(item.assetId))
    .map((item, i) => caveAnchor(`cave-${i + 1}`, item))
    .filter((a) => {
      if (!water) return true;
      const [x, , z] = a.position;
      return Math.abs(x) + a.radius < water.halfX && Math.abs(z) + a.radius < water.halfZ;
    });
}
