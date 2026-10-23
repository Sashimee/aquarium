import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  coralContentSchema,
  coralSpeciesId,
  storedCoralsSchema,
  type Coral,
  type StoredCoral,
} from '@aquarium/shared';
import { layoutPlantKeys, reconcileCorals, type CoralTable } from '@aquarium/sim/lifecycle';
import { layoutPlants, type PlantTankRow } from './plants.ts';
import type { Presets } from './presets.ts';

const BUNDLED = import.meta.url.endsWith('/src/corals.ts')
  ? null
  : fileURLToPath(new URL('./corals.json', import.meta.url));
const SOURCE_FILE = fileURLToPath(new URL('../../../content/corals.json', import.meta.url));

export function loadCoralTable(): CoralTable {
  const content = coralContentSchema.parse(
    JSON.parse(readFileSync(BUNDLED ?? SOURCE_FILE, 'utf8')) as unknown,
  );
  return { params: content.params, species: new Map(content.corals.map((c) => [c.id, c])) };
}

export interface CoralTankRow extends PlantTankRow {
  readonly corals: unknown;
}

/** The stored coral state lined up with what the tank shows now. */
export function currentCorals(
  tank: CoralTankRow,
  presets: Presets,
  table: CoralTable,
): StoredCoral[] {
  return reconcileCorals(layoutPlants(tank, presets), storedCoralsSchema.parse(tank.corals), table);
}

export function wireCorals(
  tank: CoralTankRow,
  presets: Presets,
  table: CoralTable,
  corals: readonly StoredCoral[],
): Coral[] {
  const layout = layoutPlants(tank, presets).filter((item) =>
    table.species.has(coralSpeciesId(item.assetId)),
  );
  const seedByKey = new Map(layoutPlantKeys(layout).map((key, i) => [key, layout[i]?.tintSeed]));
  return corals.map((c) => {
    const spec = table.species.get(coralSpeciesId(c.assetId));
    if (!spec) throw new Error(`coral ${c.key} has unknown asset "${c.assetId}"`);
    return {
      key: c.key,
      assetId: c.assetId,
      tintSeed: c.parentKey === null ? (seedByKey.get(c.key) ?? null) : null,
      parentKey: c.parentKey,
      position: c.parentKey === null ? null : c.position,
      size: c.size,
      minSize: spec.minSize,
      maxSize: spec.maxSize,
      fragMinSize: spec.fragMinSize,
      bleach: c.bleach,
    };
  });
}
