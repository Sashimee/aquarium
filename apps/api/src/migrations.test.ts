import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chemistrySchema, DEFAULT_EQUIPMENT, equipmentSchema } from '@aquarium/shared';
import { connect, runMigrations, type Database } from './db/index.ts';
import { hashShareToken } from './shareToken.ts';
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
    oldDir = migrationsUpTo(9);
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

describe('the public links migration on tanks that are already shared', () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let database: Database;
  let oldDir: string;
  const token = 'A'.repeat(43);

  beforeAll(async () => {
    testDb = await createTestDatabase();
    database = connect(testDb.url);
    oldDir = migrationsUpTo(10);
    await migrate(drizzle(database.pool), { migrationsFolder: oldDir });
    await database.pool.query(
      `insert into "user" (id, name, email) values ('u1', 'Sharer', 'sharer@bas.lu')`,
    );
    await database.pool.query(
      `insert into tanks (id, owner_id, biome, name, share_token) values
        ('00000000-0000-4000-8000-000000000001', 'u1', 'freshwater', 'Shared', $1),
        ('00000000-0000-4000-8000-000000000002', 'u1', 'freshwater', 'Private', null)`,
      [token],
    );
    await runMigrations(database);
  });

  afterAll(async () => {
    await database.close();
    await testDb.drop();
    rmSync(oldDir, { recursive: true, force: true });
  });

  it('keeps existing links working by storing their sha256 and drops the plain token', async () => {
    const { rows } = await database.pool.query<{ name: string; share_token_hash: string | null }>(
      'select name, share_token_hash from tanks order by name',
    );
    expect(rows).toEqual([
      { name: 'Private', share_token_hash: null },
      { name: 'Shared', share_token_hash: hashShareToken(token) },
    ]);
  });
});

describe('the blackwater CO2 migration on tanks that already have CO2', () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let database: Database;
  let oldDir: string;
  const tankId = (n: number) => `00000000-0000-4000-8000-00000000010${n}`;
  const withCo2 = (tier: number) => JSON.stringify({ ...DEFAULT_EQUIPMENT, co2: { tier } });

  const balance = async (userId: string) =>
    Number(
      (
        await database.pool.query<{ balance: number }>(
          'select balance from wallet where user_id = $1',
          [userId],
        )
      ).rows[0]?.balance,
    );
  const ledgerSum = async (userId: string) =>
    Number(
      (
        await database.pool.query<{ sum: string }>(
          'select coalesce(sum(delta), 0) as sum from ledger where user_id = $1',
          [userId],
        )
      ).rows[0]?.sum,
    );

  beforeAll(async () => {
    testDb = await createTestDatabase();
    database = connect(testDb.url);
    oldDir = migrationsUpTo(26);
    await migrate(drizzle(database.pool), { migrationsFolder: oldDir });
    await database.pool.query(
      `insert into "user" (id, name, email) values ('bw1', 'Black', 'bw1@bas.lu'), ('bw2', 'Plain', 'bw2@bas.lu')`,
    );
    await database.pool.query(
      `insert into wallet (user_id, balance) values ('bw1', 1000), ('bw2', 1000)`,
    );
    await database.pool.query(
      `insert into ledger (user_id, delta, reason, source, item_ref, idempotency_key)
       values ('bw1', 1000, 'grant', 'game', 'grant:start', 'start'), ('bw2', 1000, 'grant', 'game', 'grant:start', 'start')`,
    );
    await database.pool.query(
      `insert into tanks (id, owner_id, biome, name, equipment) values
        ($1, 'bw1', 'blackwater', 'Tier two', $5),
        ($2, 'bw1', 'blackwater', 'Tier one', $6),
        ($3, 'bw1', 'blackwater', 'Clean', $7),
        ($4, 'bw2', 'freshwater', 'Planted', $5)`,
      [tankId(1), tankId(2), tankId(3), tankId(4), withCo2(2), withCo2(1), withCo2(0)],
    );
    await runMigrations(database);
  });

  afterAll(async () => {
    await database.close();
    await testDb.drop();
    rmSync(oldDir, { recursive: true, force: true });
  });

  it('sets CO2 to 0 on blackwater tanks only', async () => {
    const { rows } = await database.pool.query<{ name: string; equipment: unknown }>(
      'select name, equipment from tanks order by name',
    );
    const tiers = Object.fromEntries(
      rows.map((r) => [r.name, equipmentSchema.parse(r.equipment).co2.tier]),
    );
    expect(tiers).toEqual({ 'Tier two': 0, 'Tier one': 0, Clean: 0, Planted: 2 });
  });

  it('refunds each removed unit through the ledger and keeps wallet and ledger in step', async () => {
    expect(await balance('bw1')).toBe(1000 + 700 + 300);
    expect(await ledgerSum('bw1')).toBe(await balance('bw1'));
    const { rows } = await database.pool.query<{ delta: number; reason: string; item_ref: string }>(
      `select delta, reason, item_ref from ledger where user_id = 'bw1' and delta <> 1000 order by delta`,
    );
    expect(rows).toEqual([
      { delta: 300, reason: 'grant', item_ref: 'grant:co2-removed-from-blackwater' },
      { delta: 700, reason: 'grant', item_ref: 'grant:co2-removed-from-blackwater' },
    ]);
  });

  it('refunds nobody else', async () => {
    expect(await balance('bw2')).toBe(1000);
    expect(await ledgerSum('bw2')).toBe(1000);
  });

  it('is idempotent: running it again refunds nothing more', async () => {
    const sql = readFileSync(join(DRIZZLE, '0027_blackwater_co2_removed.sql'), 'utf8');
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      for (const statement of sql.split('--> statement-breakpoint')) await client.query(statement);
      await client.query('commit');
    } finally {
      client.release();
    }
    expect(await balance('bw1')).toBe(2000);
    expect(await ledgerSum('bw1')).toBe(2000);
  });
});
