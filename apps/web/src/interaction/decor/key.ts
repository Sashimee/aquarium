import { legacyTintSeed, type DecorItem } from '@aquarium/shared';

/**
 * Field order is fixed so two layouts compare equal whatever order the server built them in.
 * A missing seed counts as the one the server assigns, so stamped and unstamped copies match.
 */
export function layoutKey(layout: readonly DecorItem[]): string {
  return JSON.stringify(
    layout.map(
      (i) =>
        [i.assetId, ...i.position, i.rotationY, i.scale, i.tintSeed ?? legacyTintSeed(i)] as const,
    ),
  );
}
