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
 * reach that marks one as raw. Best effort: a tank that fails or is locked is skipped, never fatal.
 */
export async function rehomeRawFrags(
  { db }: Database,
  presets: Presets,
  table: CoralTable,
): Promise<RehomeReport> {
  const candidates = await db
    .select({ id: schema.tanks.id })
    .from(schema.tanks)
    .where(
      and(
        eq(schema.tanks.biome, 'reef'),
        isNull(schema.tanks.decorLayout),
        sql`jsonb_path_exists(${schema.tanks.corals}, '$[*] ? (@.parentKey.type() == "string")')`,
      ),
    );
  let moved = 0;
  let failed = 0;
  let skipped = 0;
  for (const { id } of candidates) {
    try {
      const result = await rehomeTank(db, id, presets, table);
      if (result === 'skipped') skipped++;
      else moved += result;
    } catch (err) {
      failed++;
      console.error(
        `re-homing coral fragments failed for tank ${id}:`,
        err instanceof Error ? err.name : 'unknown',
        sqlState(err) ?? 'no-sqlstate',
      );
    }
  }
  return { moved, failed, skipped };
}

export interface RehomeReport {
  readonly moved: number;
  readonly failed: number;
  readonly skipped: number;
}

function sqlState(err: unknown): string | undefined {
  for (let e = err, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

async function rehomeTank(
  db: Database['db'],
  id: string,
  presets: Presets,
  table: CoralTable,
): Promise<number | 'skipped'> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '2s'`);
    const [tank] = await tx
      .select()
      .from(schema.tanks)
      .where(and(eq(schema.tanks.id, id), isNull(schema.tanks.decorLayout)))
      .for('update', { skipLocked: true });
    const authored = tank ? presets[tank.biome]?.decor : undefined;
    if (!tank) return 'skipped';
    if (!authored) return 0;
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
    if (changed === 0) return 0;
    await tx.update(schema.tanks).set({ corals: next }).where(eq(schema.tanks.id, id));
    return changed;
  });
}
