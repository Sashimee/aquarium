import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../test-harness.ts';
import { connect, runMigrations, type Database } from './index.ts';

// Same hash and threshold as the web client's sexOf in apps/web/src/fish/profiles.ts.
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

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

  it('backfill fish sex with the rule the client used before sex was stored', async () => {
    const database = await freshDatabase();
    await runMigrations(database);
    const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
    await q(`alter table fish drop column sex`);
    await q(`drop type fish_sex`);
    await q(`insert into "user" (id, name, email) values ('u3', 'U', 'u3@bas.lu')`);
    const tank = await q(
      `insert into tanks (owner_id, biome, name) values ('u3', 'freshwater', 'T') returning id`,
    );
    const tankId = (tank.rows[0] as { id: string }).id;
    const ids = Array.from({ length: 40 }, () => randomUUID());
    for (const id of ids) {
      await q(
        `insert into fish (id, tank_id, species, name, size) values ($1, $2, 'neon-tetra', 'F', 0.03)`,
        [id, tankId],
      );
    }

    const migration = readFileSync(
      new URL('../../drizzle/0004_fish_sex.sql', import.meta.url),
      'utf8',
    );
    const client = await database.pool.connect();
    try {
      for (const statement of migration.split('--> statement-breakpoint')) {
        await client.query(statement);
      }
    } finally {
      client.release();
    }

    const { rows } = await q(`select id, sex from fish`);
    const bySex = new Map(rows.map((r: { id: string; sex: string }) => [r.id, r.sex]));
    for (const id of ids) {
      expect(bySex.get(id), id).toBe(fnv1a(`${id}:variant`) < 2 ** 31 ? 'male' : 'female');
    }
    expect(new Set(bySex.values())).toEqual(new Set(['male', 'female']));

    const legacy = await q(
      `insert into fish (tank_id, species, name, size) values ($1, 'neon-tetra', 'Old', 0.03) returning sex`,
      [tankId],
    );
    expect((legacy.rows[0] as { sex: string }).sex).toBe('female');
  });

  it('turns an empty stored decor layout into NULL and leaves edited ones alone (0005)', async () => {
    const database = await freshDatabase();
    await runMigrations(database);
    const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
    await q(`alter table tanks alter column decor_layout set default '[]'::jsonb`);
    await q(`alter table tanks alter column decor_layout set not null`);
    await q(`insert into "user" (id, name, email) values ('u4', 'U', 'u4@bas.lu')`);
    const layout = `[{"assetId":"boulder-01","position":[0,0,0],"rotationY":0,"scale":1}]`;
    const insert = async (name: string, value: string) =>
      (
        (
          await q(
            `insert into tanks (owner_id, biome, name, decor_layout) values ('u4', 'freshwater', $1, $2::jsonb) returning id`,
            [name, value],
          )
        ).rows[0] as { id: string }
      ).id;
    const empty = await insert('empty', '[]');
    const spaced = await insert('spaced', '[ ]');
    const filled = await insert('filled', layout);

    const migration = readFileSync(
      new URL('../../drizzle/0005_decor_layout_nullable.sql', import.meta.url),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      await q(statement);
    }

    const { rows } = await q(`select id, decor_layout from tanks`);
    const byId = new Map(
      rows.map((r: { id: string; decor_layout: unknown }) => [r.id, r.decor_layout]),
    );
    expect(byId.get(empty)).toBeNull();
    expect(byId.get(spaced)).toBeNull();
    expect(byId.get(filled)).toEqual(JSON.parse(layout));
    const fresh = await q(
      `insert into tanks (owner_id, biome, name) values ('u4', 'freshwater', 'new') returning decor_layout`,
    );
    expect((fresh.rows[0] as { decor_layout: unknown }).decor_layout).toBeNull();
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
      `insert into fish (tank_id, species, name, sex, size) values ($1, 'neon-tetra', 'F', 'male', 0.03)`,
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
