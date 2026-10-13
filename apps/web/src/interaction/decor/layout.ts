import type { DecorItem, DecorLayout } from '@aquarium/shared';
import { VACATION_FEEDER_ASSET_ID, type DecorSpec } from './spec';

export interface Piece {
  readonly id: string;
  readonly item: DecorItem;
}

export function hasVacationFeeder(layout: readonly DecorItem[]): boolean {
  return layout.some((i) => i.assetId === VACATION_FEEDER_ASSET_ID);
}

/** Items the player can move: the ones with a spec. Plants and anemones stay where the preset put them. */
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
