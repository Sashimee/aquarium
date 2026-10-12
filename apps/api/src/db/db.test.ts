import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../test-harness.ts';
import { connect, runMigrations, type Database } from './index.ts';

const opened: Database[] = [];
const drops: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(opened.map((d) => d.close()));
  await Promise.all(drops.map((d) => d()));
});

async function freshDatabase(): Promise<Database> {
  const testDb = await createTestDatabase();
  drops.push(testDb.drop);
  const database = connect(testDb.url);
  opened.push(database);
  return database;
}

describe('migrations', () => {
  it('create the auth and game tables and are idempotent', async () => {
    const database = await freshDatabase();
    await runMigrations(database);
    await runMigrations(database);
    const { rows } = await database.pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const names = rows.map((r) => r.table_name);
    for (const table of [
      'user',
      'session',
      'account',
      'verification',
      'passkey',
      'tanks',
      'fish',
      'events',
      'memorials',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('fail loudly when the database is unreachable', async () => {
    const database = connect('postgres://aquarium:wrong@127.0.0.1:1/none');
    opened.push(database);
    await expect(runMigrations(database)).rejects.toThrow();
  });
});

describe('schema', () => {
  it('cascades from the user down to tanks, fish, events and memorials', async () => {
    const database = await freshDatabase();
    await runMigrations(database);
    const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
    await q(`insert into "user" (id, name, email) values ('u1', 'U', 'u1@bas.lu')`);
    const tank = await q(
      `insert into tanks (owner_id, biome, name) values ('u1', 'freshwater', 'T') returning id`,
    );
    const tankId = (tank.rows[0] as { id: string }).id;
    await q(
      `insert into fish (tank_id, species, name, size) values ($1, 'neon-tetra', 'F', 0.03)`,
      [tankId],
    );
    await q(`insert into events (tank_id, kind, payload) values ($1, 'feed', '{"portion":1}')`, [
      tankId,
    ]);
    await q(
      `insert into memorials (tank_id, fish_name, species, born_at, died_at, cause)
       values ($1, 'F', 'neon-tetra', now(), now(), 'starvation')`,
      [tankId],
    );

    await q(`delete from "user" where id = 'u1'`);
    for (const table of ['tanks', 'fish', 'events', 'memorials']) {
      const { rows } = await q(`select count(*)::int as n from ${table}`);
      expect((rows[0] as { n: number }).n, table).toBe(0);
    }
  });

  it('rejects invalid biome and cause values', async () => {
    const database = await freshDatabase();
    await runMigrations(database);
    await database.pool.query(
      `insert into "user" (id, name, email) values ('u2', 'U', 'u2@bas.lu')`,
    );
    await expect(
      database.pool.query(`insert into tanks (owner_id, biome, name) values ('u2', 'lake', 'T')`),
    ).rejects.toThrow();
  });
});
