import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decorLayoutSchema,
  fitPresetDecor,
  legacyTintSeed,
  plantContentSchema,
  storedPlantsSchema,
  TANK_SIZES,
  type DecorItem,
  type Plant,
  type StoredPlant,
  type TankSize,
} from '@aquarium/shared';
import {
  layoutPlantKeys,
  obstaclesOf,
  reconcilePlants,
  type LayoutPlant,
  type Obstacle,
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
  return {
    params: content.params,
    species: new Map(content.plants.map((p) => [p.id, p])),
    hardscape: new Map(content.hardscape.map((h) => [h.id, h])),
  };
}

export function substrateBounds(size: TankSize): PlantBounds {
  const { length, depth, glass } = TANK_SIZES[size].dimensions;
  return { halfX: length / 2 - glass, halfZ: depth / 2 - glass };
}

export interface PlantTankRow {
  readonly biome: keyof Presets;
  readonly size: TankSize;
  readonly decorLayout: unknown;
  readonly plants: unknown;
}

export function layoutPlants(tank: PlantTankRow, presets: Presets): LayoutPlant[] {
  const layout =
    tank.decorLayout === null
      ? fitPresetDecor(presets[tank.biome]?.decor ?? [], tank.size)
      : decorLayoutSchema.parse(tank.decorLayout);
  return layout.map((item) => ({
    assetId: item.assetId,
    position: item.position,
    rotationY: item.rotationY,
    scale: item.scale,
    tintSeed: item.tintSeed ?? legacyTintSeed(item),
  }));
}

export function shownTintSeeds(tank: PlantTankRow, presets: Presets): number[] {
  return layoutPlants(tank, presets).map((item) => item.tintSeed);
}

const FNV_PRIME = 16777619;

/**
 * Fills in missing tint seeds and gives a repeated seed a new one, so every piece keys its own growth
 * state. Seeds the tank already showed keep working, repeats included: a seed may occur as often as it
 * did in `previous`, and only the occurrences past that get a new seed. Nothing is rejected, because a
 * saved layout with repeats must stay saveable.
 */
export function uniqueTintSeeds<T extends Pick<DecorItem, 'position' | 'rotationY' | 'tintSeed'>>(
  layout: readonly T[],
  previous: readonly number[],
): (T & { tintSeed: number })[] {
  const allowed = new Map<number, number>();
  for (const seed of previous) allowed.set(seed, (allowed.get(seed) ?? 0) + 1);
  const wanted = layout.map((item) => item.tintSeed ?? legacyTintSeed(item));
  const taken = new Set(wanted);
  const seen = new Map<number, number>();
  return layout.map((item, index) => {
    const seed = wanted[index] ?? legacyTintSeed(item);
    const count = (seen.get(seed) ?? 0) + 1;
    seen.set(seed, count);
    if (count <= Math.max(1, allowed.get(seed) ?? 0)) return { ...item, tintSeed: seed };
    let fresh = seed;
    for (let attempt = 1; taken.has(fresh); attempt++) {
      fresh = (Math.imul(seed ^ (index + 1), FNV_PRIME) + attempt) >>> 0;
    }
    taken.add(fresh);
    return { ...item, tintSeed: fresh };
  });
}

export function plantObstacles(
  tank: PlantTankRow,
  presets: Presets,
  table: PlantTable,
): Obstacle[] {
  return obstaclesOf(layoutPlants(tank, presets), table);
}

/** The stored growth state lined up with what the tank shows now. */
export function currentPlants(
  tank: PlantTankRow,
  presets: Presets,
  table: PlantTable,
): StoredPlant[] {
  return reconcilePlants(
    layoutPlants(tank, presets),
    storedPlantsSchema.parse(tank.plants),
    table,
    substrateBounds(tank.size),
  );
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
