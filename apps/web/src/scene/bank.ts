import { Vector3 } from 'three/webgpu';
import type { DecorItem } from '@aquarium/shared';
import { decorMatrix } from './hardscape';
import type { WaterReach } from './caves';

/**
 * A dry perch above the water, for amphibious fish. Not a `SceneAnchor`: the sim rejects kinds
 * other than anemone and cave, so these travel on their own list until it can use them.
 */
export interface SceneBank {
  readonly id: string;
  readonly kind: 'bank';
  /** Centre of the perch's top face, in the frame the scene and sim share. */
  readonly position: readonly [number, number, number];
  /** Horizontal radius of the flat part a fish can rest on. */
  readonly radius: number;
}

/** The top of a perch in the asset's own frame (origin at the base centre, metres at scale 1). */
interface BankTop {
  readonly position: readonly [number, number, number];
  readonly radius: number;
}

export const BANK_TOPS: Readonly<Record<string, BankTop>> = {
  'mangrove-stump': { position: [0, 0.28, 0], radius: 0.05 },
};

export function bankAnchor(id: string, item: DecorItem): SceneBank {
  const top = BANK_TOPS[item.assetId];
  if (!top) throw new Error(`"${item.assetId}" has no bank top; add it to BANK_TOPS`);
  const position = new Vector3(...top.position).applyMatrix4(decorMatrix(item));
  return {
    id,
    kind: 'bank',
    position: [position.x, position.y, position.z],
    radius: top.radius * item.scale,
  };
}

/**
 * Only a perch whose top clears `waterTop` is a bank, and only one inside the water's footprint is
 * reachable, so a stump drowned in a deeper tank, or outside a smaller one, is left out. Ids stay
 * tied to the item's place in the list.
 */
export function bankAnchors(
  items: readonly DecorItem[],
  waterTop: number,
  water?: WaterReach,
): SceneBank[] {
  return items
    .filter((item) => item.assetId in BANK_TOPS)
    .map((item, i) => bankAnchor(`bank-${i + 1}`, item))
    .filter((b) => {
      const [x, y, z] = b.position;
      if (y < waterTop) return false;
      if (!water) return true;
      return Math.abs(x) + b.radius < water.halfX && Math.abs(z) + b.radius < water.halfZ;
    });
}
