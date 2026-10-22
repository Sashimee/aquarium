import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  coralContentSchema,
  coralSpeciesId,
  fitPresetItem,
  legacyTintSeed,
  storedCoralsSchema,
  type Coral,
  type StoredCoral,
} from '@aquarium/shared';
import {
  layoutPlantKeys,
  reconcileCorals,
  rehomeFrags,
  type CoralTable,
  type RootMove,
} from '@aquarium/sim/lifecycle';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from './db/index.ts';
import { layoutPlants, substrateBounds, type PlantTankRow } from './plants.ts';
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

/**
 * Fragments cut before the fitted-coordinates fix were stored in raw preset coordinates. Moves them
 * by their colony's fit shift; safe to run on every start, since a moved fragment is out of the
 * reach that marks one as raw.
 */
export async function rehomeRawFrags(
  { db }: Database,
  presets: Presets,
  table: CoralTable,
): Promise<number> {
  const candidates = await db
    .select({ id: schema.tanks.id })
    .from(schema.tanks)
    .where(
      and(isNull(schema.tanks.decorLayout), sql`jsonb_array_length(${schema.tanks.corals}) > 0`),
    );
  let moved = 0;
  for (const { id } of candidates) {
    await db.transaction(async (tx) => {
      const [tank] = await tx
        .select()
        .from(schema.tanks)
        .where(and(eq(schema.tanks.id, id), isNull(schema.tanks.decorLayout)))
        .for('update');
      const authored = tank ? presets[tank.biome]?.decor : undefined;
      if (!tank || !authored) return;
      const corals = authored.filter((item) => table.species.has(coralSpeciesId(item.assetId)));
      const keys = layoutPlantKeys(
        corals.map((item) => ({ ...item, tintSeed: item.tintSeed ?? legacyTintSeed(item) })),
      );
      const roots = new Map<string, RootMove>();
      corals.forEach((item, i) => {
        const key = keys[i];
        if (key === undefined) return;
        const fitted = fitPresetItem(item, tank.size);
        roots.set(key, {
          from: [item.position[0], item.position[2]],
          to: [fitted.position[0], fitted.position[2]],
        });
      });
      const stored = storedCoralsSchema.parse(tank.corals);
      const next = rehomeFrags(stored, roots, table, substrateBounds(tank.size));
      const changed = next.filter((c, i) => c !== stored[i]).length;
      if (changed === 0) return;
      await tx.update(schema.tanks).set({ corals: next }).where(eq(schema.tanks.id, id));
      moved += changed;
    });
  }
  return moved;
}
