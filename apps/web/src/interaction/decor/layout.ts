import {
  isDecorAssetForBiome,
  type Biome,
  type DecorItem,
  type DecorLayout,
} from '@aquarium/shared';
import { withinServerBounds } from './rules';
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
}

/** Makes a saved layout one the server accepts: wrong-biome pieces and extra feeders go, strays are pulled inside. */
export function sanitizeLayout(layout: readonly DecorItem[], biome: Biome): Sanitized {
  const kept: DecorItem[] = [];
  let feeder = false;
  for (const item of layout) {
    if (item.assetId === VACATION_FEEDER_ASSET_ID) {
      if (feeder) continue;
      feeder = true;
    } else if (!isDecorAssetForBiome(biome, item.assetId)) {
      continue;
    }
    kept.push(withinServerBounds(item));
  }
  return { layout: kept, dropped: layout.length - kept.length };
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
