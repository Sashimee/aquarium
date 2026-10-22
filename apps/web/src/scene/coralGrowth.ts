import { legacyTintSeed, type Coral, type DecorItem } from '@aquarium/shared';
import { hashKey } from './plantGrowth';
import { mulberry32 } from './placement';
import type { AssetCatalog } from './assets';
import type { CurrentParameters } from './current';
import type { TankDimensions } from '../engine/tank/dimensions';
import {
  euphylliaCapsule,
  parseEuphylliaId,
  type EuphylliaCapsule,
  type EuphylliaMesh,
} from './euphyllia';
import { boundsFromCatalog, maxScaleAt, type FitModel } from './presetFit';

const MAX_ANCESTORS = 64;
const MIN_FRAGMENT_SCALE_FRACTION = 0.25;

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

/**
 * Largest scale an item can take where it stands; the glass and the surface are the limit.
 * A fragment of a swaying coral is floored above it, so its sway can cross the glass.
 */
export type ScaleCap = (item: DecorItem) => number;

/**
 * The item at the colony's grown size, held to `cap` so it never crosses the glass or the
 * waterline. A colony the layout already placed at its limit keeps its placed scale, and shrinks
 * freely when fragged.
 */
export function grownCoralItem(
  item: DecorItem,
  coral: Coral | undefined,
  cap: ScaleCap = () => Infinity,
): DecorItem {
  if (!coral) return item;
  const size = clampedSize(coral);
  if (size === 1) return item;
  const wanted = item.scale * size;
  const scale = size < 1 ? wanted : Math.min(wanted, Math.max(item.scale, cap(item)));
  return scale === item.scale ? item : { ...item, scale };
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
  cap: ScaleCap = () => Infinity,
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
    const standing: DecorItem = {
      ...root.item,
      position: [x, ground(x, z), z],
      rotationY: mulberry32(hashKey(coral.key))() * Math.PI * 2,
    };
    const wanted = root.item.scale * clampedSize(coral);
    const capped = Math.min(wanted, cap(standing));
    const scale =
      parseEuphylliaId(root.assetId) === null
        ? capped
        : Math.max(capped, Math.min(wanted, root.item.scale * MIN_FRAGMENT_SCALE_FRACTION));
    placed.push({ coral, rootIndex, item: { ...standing, scale } });
  }
  return placed;
}

export type CoralOrigin = { readonly hard: number } | { readonly euphyllia: number };

export interface CoralLayoutSlot extends CoralSlot {
  readonly origin: CoralOrigin;
}

/**
 * The single coral slot order: the preset's own order, with edited pieces taking the place of the
 * preset piece before them and any extra after. `hardCorals` are the layout's hard corals in layout
 * order, each with its index in the hardscape list; `euphyllias` the procedural colonies in preset
 * order. This is the order the server numbers repeated tint seeds in, so a slot index is what
 * `matchLayoutCorals` returns.
 */
export function coralSlotOrder(
  presetDecor: readonly DecorItem[],
  kindOf: (assetId: string) => string,
  hardItems: readonly { readonly item: DecorItem; readonly kind: string }[],
  euphyllias: readonly DecorItem[],
): CoralLayoutSlot[] {
  const hardCorals = hardItems.flatMap(({ item, kind }, index) =>
    kind === 'coral' ? [{ index, item }] : [],
  );
  const slots: CoralLayoutSlot[] = [];
  let nextHard = 0;
  let nextEuphyllia = 0;
  const takeHard = () => {
    const entry = hardCorals[nextHard++];
    if (entry) {
      slots.push({ assetId: entry.item.assetId, item: entry.item, origin: { hard: entry.index } });
    }
  };
  for (const decor of presetDecor) {
    if (parseEuphylliaId(decor.assetId)) {
      const item = euphyllias[nextEuphyllia];
      if (!item) continue;
      slots.push({ assetId: item.assetId, item, origin: { euphyllia: nextEuphyllia++ } });
    } else if (kindOf(decor.assetId) === 'coral') {
      takeHard();
    }
  }
  while (nextHard < hardCorals.length) takeHard();
  return slots;
}

/** The euphyllia capsule at the colony's grown size, with its lean, as `setCorals` fits it. */
export function grownEuphylliaCapsule(
  bounds: EuphylliaMesh['bounds'],
  item: DecorItem,
  coral: Coral | undefined,
  cap: ScaleCap,
): EuphylliaCapsule {
  return euphylliaCapsule(bounds, grownCoralItem(item, coral, cap));
}

/** The one scale cap the scene fits corals with, including a swaying colony's reach in the current. */
export function coralScaleCap(
  catalog: Pick<AssetCatalog, 'get'>,
  dimensions: TankDimensions,
  current: CurrentParameters,
): ScaleCap {
  const modelOf = boundsFromCatalog(catalog, current);
  const models = new Map<string, FitModel | null>();
  return (item) => {
    if (!models.has(item.assetId)) models.set(item.assetId, modelOf(item.assetId));
    return maxScaleAt(item, dimensions, models.get(item.assetId) ?? null);
  };
}
