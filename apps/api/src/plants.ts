import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decorLayoutSchema,
  legacyTintSeed,
  plantContentSchema,
  storedPlantsSchema,
  TANK_SIZES,
  type Plant,
  type StoredPlant,
  type TankSize,
} from '@aquarium/shared';
import {
  layoutPlantKeys,
  reconcilePlants,
  type LayoutPlant,
  type PlantBounds,
  type PlantTable,
} from '@aquarium/sim/lifecycle';
import type { Presets } from './presets.ts';

const BUNDLED = import.meta.url.endsWith('/src/plants.ts')
  ? null
  : fileURLToPath(new URL('./plants.json', import.meta.url));
const SOURCE_FILE = fileURLToPath(new URL('../../../content/plants.json', import.meta.url));

export function loadPlantTable(): PlantTable {
  const content = plantContentSchema.parse(
    JSON.parse(readFileSync(BUNDLED ?? SOURCE_FILE, 'utf8')) as unknown,
  );
  return { params: content.params, species: new Map(content.plants.map((p) => [p.id, p])) };
}

export function substrateBounds(size: TankSize): PlantBounds {
  const { length, depth, glass } = TANK_SIZES[size].dimensions;
  return { halfX: length / 2 - glass, halfZ: depth / 2 - glass };
}

interface PlantTankRow {
  readonly biome: keyof Presets;
  readonly size: TankSize;
  readonly decorLayout: unknown;
  readonly plants: unknown;
}

function layoutPlants(tank: PlantTankRow, presets: Presets): LayoutPlant[] {
  const layout =
    tank.decorLayout === null
      ? (presets[tank.biome]?.decor ?? [])
      : decorLayoutSchema.parse(tank.decorLayout);
  return layout.map((item) => ({
    assetId: item.assetId,
    position: item.position,
    tintSeed: item.tintSeed ?? legacyTintSeed(item),
  }));
}

/** The stored growth state lined up with what the tank shows now. */
export function currentPlants(
  tank: PlantTankRow,
  presets: Presets,
  table: PlantTable,
): StoredPlant[] {
  return reconcilePlants(layoutPlants(tank, presets), storedPlantsSchema.parse(tank.plants), table);
}

export function wirePlants(
  tank: PlantTankRow,
  presets: Presets,
  table: PlantTable,
  plants: readonly StoredPlant[],
): Plant[] {
  const layout = layoutPlants(tank, presets).filter((item) => table.species.has(item.assetId));
  const seedByKey = new Map(layoutPlantKeys(layout).map((key, i) => [key, layout[i]?.tintSeed]));
  return plants.map((p) => {
    const spec = table.species.get(p.assetId);
    if (!spec) throw new Error(`plant ${p.key} has unknown asset "${p.assetId}"`);
    return {
      key: p.key,
      assetId: p.assetId,
      tintSeed: p.parentKey === null ? (seedByKey.get(p.key) ?? null) : null,
      parentKey: p.parentKey,
      position: p.parentKey === null ? null : p.position,
      size: p.size,
      minSize: spec.minSize,
      maxSize: spec.maxSize,
    };
  });
}
