import type { Coral } from '@aquarium/shared';
import { footprintOf, rayHit, type RayLike } from './footprint';
import type { PlacedCoral } from './coralColliders';
import type { DecorSpec, Vec3Tuple } from './spec';

type Box = { readonly min: Vec3Tuple; readonly max: Vec3Tuple };

/** A finger is wider than a small coral; the model box grows by this much on every side. */
export const PICK_MARGIN_M = 0.01;

/**
 * The coral the ray enters first, by the same box test the decor editor picks pieces with. A
 * colony and its fragments are separate hits, so a tap on a fragment selects the fragment.
 */
export function pickCoral(
  placed: readonly PlacedCoral[],
  specs: ReadonlyMap<string, DecorSpec>,
  boundsOf: (assetId: string) => Box | null,
  ray: RayLike,
): Coral | null {
  let best: { coral: Coral; t: number } | null = null;
  for (const { coral, item } of placed) {
    const box = specs.get(item.assetId)?.box ?? boundsOf(item.assetId);
    if (!box) continue;
    const base = footprintOf({ box }, item);
    const t = rayHit(
      {
        ...base,
        hx: base.hx + PICK_MARGIN_M,
        hz: base.hz + PICK_MARGIN_M,
        yMin: base.yMin - PICK_MARGIN_M,
        yMax: base.yMax + PICK_MARGIN_M,
      },
      ray,
    );
    if (t !== null && (!best || t < best.t)) best = { coral, t };
  }
  return best?.coral ?? null;
}
