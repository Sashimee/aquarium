import {
  isDecorAssetForBiome,
  type Biome,
  type DecorItem,
  type DecorLayout,
} from '@aquarium/shared';
import { SURFACE_MARGIN } from '../../scene/plants';
import { MIN_PLANT_SCALE, withinServerBounds } from './rules';
import { VACATION_FEEDER_ASSET_ID, type DecorSpec } from './spec';

export interface Piece {
  readonly id: string;
  readonly item: DecorItem;
}

export function hasVacationFeeder(layout: readonly DecorItem[]): boolean {
  return layout.some((i) => i.assetId === VACATION_FEEDER_ASSET_ID);
}

export interface Sanitized {
  readonly layout: DecorItem[];
  readonly dropped: number;
  readonly shrunk: number;
}

export interface PlantFit {
  readonly specs: ReadonlyMap<string, DecorSpec>;
  readonly waterTop: number;
}

/** A plant that pokes through the surface is scaled down to fit; one that would shrink too far is dropped. */
function fitPlant(item: DecorItem, fit: PlantFit): DecorItem | null {
  const spec = fit.specs.get(item.assetId);
  if (spec?.kind !== 'plant') return item;
  const height = spec.box.max[1] * item.scale;
  const available = fit.waterTop - SURFACE_MARGIN - item.position[1];
  if (available >= height) return item;
  const scale = Math.floor((item.scale * available * 1000) / height) / 1000;
  return scale < MIN_PLANT_SCALE ? null : { ...item, scale };
}

/** Makes a saved layout one the server accepts: wrong-biome pieces and extra feeders go, strays are pulled inside, tall plants shrink. */
export function sanitizeLayout(
  layout: readonly DecorItem[],
  biome: Biome,
  fit?: PlantFit,
): Sanitized {
  const kept: DecorItem[] = [];
  let feeder = false;
  let shrunk = 0;
  for (const item of layout) {
    if (item.assetId === VACATION_FEEDER_ASSET_ID) {
      if (feeder) continue;
      feeder = true;
    } else if (!isDecorAssetForBiome(biome, item.assetId)) {
      continue;
    }
    const bounded = withinServerBounds(item);
    const fitted = fit ? fitPlant(bounded, fit) : bounded;
    if (!fitted) continue;
    if (fitted.scale < bounded.scale) shrunk += 1;
    kept.push(fitted);
  }
  return { layout: kept, dropped: layout.length - kept.length, shrunk };
}

/** Items the player can move: the ones with a spec. Anemones and procedural corals stay where the preset put them. */
export function splitLayout(
  layout: readonly DecorItem[],
  specs: ReadonlyMap<string, DecorSpec>,
): { pieces: DecorItem[]; unmanaged: DecorItem[] } {
  const pieces: DecorItem[] = [];
  const unmanaged: DecorItem[] = [];
  for (const item of layout) (specs.has(item.assetId) ? pieces : unmanaged).push(item);
  return { pieces, unmanaged };
}

export function composeLayout(
  unmanaged: readonly DecorItem[],
  pieces: readonly Piece[],
): DecorLayout {
  return [...unmanaged, ...pieces.map((p) => p.item)];
}

export function numberPieces(items: readonly DecorItem[]): Piece[] {
  return items.map((item, i) => ({ id: `p${i + 1}`, item }));
}
