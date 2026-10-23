import type { DecorItem } from '@aquarium/shared';
import { parseEuphylliaId, type EuphylliaVariant } from './euphyllia';
import { isMudBankId } from './mudBank';
import { HARDSCAPE_KINDS, PLANT_KIND } from './hardscape';

export interface RoutedDecor {
  readonly hardItems: { item: DecorItem; kind: string }[];
  readonly layoutPlants: DecorItem[];
  readonly anemoneItems: DecorItem[];
  readonly euphylliaItems: readonly { item: DecorItem; variant: EuphylliaVariant; seed: number }[];
  readonly mudBankItems: DecorItem[];
}

/** Sorts a preset's decor into the groups the scene builds, in preset order within each group. */
export function routeDecor(
  decor: readonly DecorItem[],
  kindOf: (assetId: string) => string,
): RoutedDecor {
  const euphylliaItems: RoutedDecor['euphylliaItems'][number][] = [];
  const routed: RoutedDecor = {
    hardItems: [],
    layoutPlants: [],
    anemoneItems: [],
    euphylliaItems,
    mudBankItems: [],
  };
  for (const item of decor) {
    if (isMudBankId(item.assetId)) {
      routed.mudBankItems.push(item);
      continue;
    }
    const procedural = parseEuphylliaId(item.assetId);
    if (procedural) {
      euphylliaItems.push({ item, ...procedural });
      continue;
    }
    const kind = kindOf(item.assetId);
    if (HARDSCAPE_KINDS.has(kind)) routed.hardItems.push({ item, kind });
    else if (kind === PLANT_KIND) routed.layoutPlants.push(item);
    else if (kind === 'anemone') routed.anemoneItems.push(item);
    else throw new Error(`Preset item "${item.assetId}" is a ${kind}, which a tank cannot hold`);
  }
  return routed;
}
