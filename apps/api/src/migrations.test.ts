import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chemistrySchema, DEFAULT_EQUIPMENT, equipmentSchema } from '@aquarium/shared';
import { connect, runMigrations, type Database } from './db/index.ts';
import { createTestDatabase } from './test-harness.ts';

const DRIZZLE = fileURLToPath(new URL('../drizzle', import.meta.url));

function migrationsUpTo(lastIdx: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'aq-migrations-'));
  mkdirSync(join(dir, 'meta'));
  const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const kept = journal.entries.filter((e) => e.idx <= lastIdx);
  for (const e of kept) cpSync(join(DRIZZLE, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: kept }));
  return dir;
}

describe('the chemistry v2 migration on tanks that already exist', () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let database: Database;
  let oldDir: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    database = connect(testDb.url);
    oldDir = migrationsUpTo(8);
    await migrate(drizzle(database.pool), { migrationsFolder: oldDir });
    await database.pool.query(
      `insert into "user" (id, name, email) values ('u1', 'Old timer', 'old@bas.lu')`,
    );
    await database.pool.query(
      `insert into tanks (id, owner_id, biome, name, water) values
        ('00000000-0000-4000-8000-000000000001', 'u1', 'freshwater', 'Old tank', '{"ammonia":0.1,"nitrate":3,"algae":0.2,"uneatenFood":0}'),
        ('00000000-0000-4000-8000-000000000002', 'u1', 'reef', 'Old reef', '{"ammonia":0,"nitrate":1,"algae":0,"uneatenFood":0}')`,
    );
    await database.pool.query(
      `insert into tanks (id, owner_id, biome, name, equipment) values
        ('00000000-0000-4000-8000-000000000004', 'u1', 'freshwater', 'Warm tank', $1)`,
      [JSON.stringify({ ...DEFAULT_EQUIPMENT, heater: { tier: 2 } })],
    );
    await runMigrations(database);
  });

  afterAll(async () => {
    await database.close();
    await testDb.drop();
    rmSync(oldDir, { recursive: true, force: true });
  });

  it('keeps both bacteria colonies full, so the tank is cycled', async () => {
    const { rows } = await database.pool.query<{ chemistry: unknown }>(
      'select chemistry from tanks order by name',
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const chemistry = chemistrySchema.parse(row.chemistry);
      expect(chemistry.bacteria).toEqual({ ammoniaOxidisers: 1, nitriteOxidisers: 1 });
      expect(chemistry.nitrite).toBe(0);
    }
  });

  it('puts a heater on tanks that had none and leaves the rest alone', async () => {
    const { rows } = await database.pool.query<{ equipment: unknown; water: { nitrate: number } }>(
      `select equipment, water from tanks where name = 'Old tank'`,
    );
    const equipment = equipmentSchema.parse(rows[0]?.equipment);
    expect(equipment.heater.tier).toBe(1);
    expect(equipment.filter.tier).toBe(1);
    expect(rows[0]?.water.nitrate).toBe(3);
  });

  it('keeps a heater that was already above tier 0', async () => {
    const { rows } = await database.pool.query<{ equipment: unknown }>(
      `select equipment from tanks where name = 'Warm tank'`,
    );
    expect(equipmentSchema.parse(rows[0]?.equipment).heater.tier).toBe(2);
  });

  it('gives a tank created afterwards the same seeded filter and heater', async () => {
    await database.pool.query(
      `insert into tanks (id, owner_id, biome, name) values ('00000000-0000-4000-8000-000000000003', 'u1', 'freshwater', 'New')`,
    );
    const { rows } = await database.pool.query<{ equipment: unknown; chemistry: unknown }>(
      `select equipment, chemistry from tanks where name = 'New'`,
    );
    expect(equipmentSchema.parse(rows[0]?.equipment).heater.tier).toBe(1);
    expect(chemistrySchema.parse(rows[0]?.chemistry).bacteria.ammoniaOxidisers).toBe(1);
  });
});
