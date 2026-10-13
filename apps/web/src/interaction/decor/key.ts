import type { DecorItem } from '@aquarium/shared';

/** Field order is fixed so two layouts compare equal whatever order the server built them in. */
export function layoutKey(layout: readonly DecorItem[]): string {
  return JSON.stringify(
    layout.map((i) => [i.assetId, ...i.position, i.rotationY, i.scale] as const),
  );
}
