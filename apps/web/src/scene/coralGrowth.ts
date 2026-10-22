import { legacyTintSeed, type Coral, type DecorItem } from '@aquarium/shared';
import { hashKey } from './plantGrowth';
import { mulberry32 } from './placement';

const MAX_ANCESTORS = 64;

export interface CoralSlot {
  readonly assetId: string;
  readonly item: DecorItem;
}

/**
 * The state coral each layout item is, by asset and tint seed. Keys are `s<seed>` and, for a
 * second piece with the same seed, `s<seed>-2`, counted in layout order as the server does.
 */
export function matchLayoutCorals(
  slots: readonly CoralSlot[],
  corals: readonly Coral[],
): Map<number, Coral> {
  const byKey = new Map(corals.filter((c) => c.parentKey === null).map((c) => [c.key, c]));
  const seen = new Map<string, number>();
  const matched = new Map<number, Coral>();
  slots.forEach(({ assetId, item }, index) => {
    const base = `s${item.tintSeed ?? legacyTintSeed(item)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const coral = byKey.get(n === 1 ? base : `${base}-${n}`);
    if (coral && coral.assetId === assetId) matched.set(index, coral);
  });
  return matched;
}

function clampedSize(coral: Coral): number {
  return Math.min(coral.maxSize, Math.max(coral.minSize, coral.size));
}

/** The item at the colony's grown size. A coral keeps the placed scale at size 1. */
export function grownCoralItem(item: DecorItem, coral: Coral | undefined): DecorItem {
  if (!coral) return item;
  const size = clampedSize(coral);
  return size === 1 ? item : { ...item, scale: item.scale * size };
}

export interface PlacedFragment {
  readonly coral: Coral;
  readonly rootIndex: number;
  readonly item: DecorItem;
}

function rootIndexOf(
  coral: Coral,
  byKey: ReadonlyMap<string, Coral>,
  indexByKey: ReadonlyMap<string, number>,
): number | null {
  let current: Coral | undefined = coral;
  for (let steps = 0; current && steps < MAX_ANCESTORS; steps++) {
    if (current.parentKey === null) return indexByKey.get(current.key) ?? null;
    current = byKey.get(current.parentKey);
  }
  return null;
}

/**
 * Fragments as decor items standing on the substrate, sized from the colony they were cut from.
 * A fragment whose colony is no longer in the layout is left out until the layout catches up.
 */
export function placeFragments(
  slots: readonly CoralSlot[],
  corals: readonly Coral[],
  ground: (x: number, z: number) => number,
): PlacedFragment[] {
  const matched = matchLayoutCorals(slots, corals);
  const indexByKey = new Map([...matched].map(([index, coral]) => [coral.key, index]));
  const byKey = new Map(corals.map((c) => [c.key, c]));
  const placed: PlacedFragment[] = [];
  for (const coral of corals) {
    if (coral.parentKey === null || coral.position === null) continue;
    const rootIndex = rootIndexOf(coral, byKey, indexByKey);
    const root = rootIndex === null ? undefined : slots[rootIndex];
    if (rootIndex === null || !root || root.assetId !== coral.assetId) continue;
    const [x, z] = coral.position;
    placed.push({
      coral,
      rootIndex,
      item: {
        ...root.item,
        position: [x, ground(x, z), z],
        rotationY: mulberry32(hashKey(coral.key))() * Math.PI * 2,
        scale: root.item.scale * clampedSize(coral),
      },
    });
  }
  return placed;
}
