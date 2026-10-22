import { Vector3 } from 'three/webgpu';
import type { DecorItem } from '@aquarium/shared';
import { decorMatrix } from './hardscape';
import type { WaterReach } from './caves';

/**
 * A point above the water an amphibious fish can cling to or climb toward, not a flat area to rest
 * on: the one scanned stump offers a spike tip about 1.2 x 1.4 cm across. Not a `SceneAnchor`, since
 * the sim rejects kinds other than anemone and cave, so these travel on their own list.
 */
export interface SceneBank {
  readonly id: string;
  readonly kind: 'bank';
  /** The cling point, in the frame the scene and sim share. */
  readonly position: readonly [number, number, number];
  /** Horizontal radius of the tip a fish can grip. */
  readonly radius: number;
}

/** The top of a perch in the asset's own frame (origin at the base centre, metres at scale 1). */
interface BankTop {
  readonly position: readonly [number, number, number];
  readonly radius: number;
}

/**
 * The scanned stump leans: the centre is only 17 cm high, and above 27 cm the mesh is a spike tip
 * about 1.2 x 1.4 cm across, centred near local (0.006, 0.074). The point sits at the tip.
 */
export const BANK_TOPS: Readonly<Record<string, BankTop>> = {
  'mangrove-stump': { position: [0.006, 0.275, 0.074], radius: 0.007 },
};

/** The least a cling point stands above the water top; less is not an emergent surface. */
export const BANK_CLEARANCE = 0.01;

/** How far under the rim a perch's highest point stays. */
export const BANK_RIM_MARGIN = 0.01;
/** A bank-asset item authored at least this large is the preset's perch, not ordinary wood. */
export const PERCH_MIN_SCALE = 1.3;
/** A perch is not shrunk with the tank; it grows up to this much past its authored scale to reach the rim. */
export const PERCH_GROWTH = 1.25;
/** A perch fitted smaller than this is too slight to stand clear of the water; it is ordinary wood. */
export const PERCH_MIN_FIT = 1;

export function isPerch(item: DecorItem): boolean {
  return item.assetId in BANK_TOPS && item.scale >= PERCH_MIN_SCALE;
}

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
 * Only a perch whose point clears `waterTop` by `BANK_CLEARANCE` is a bank, and only one inside the water's footprint is
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
      if (y < waterTop + BANK_CLEARANCE) return false;
      if (!water) return true;
      return Math.abs(x) + b.radius < water.halfX && Math.abs(z) + b.radius < water.halfZ;
    });
}
