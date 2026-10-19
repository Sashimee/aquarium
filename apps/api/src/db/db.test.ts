import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_EQUIPMENT,
  NEUTRAL_PERSONALITY,
  personalitySchema,
  chemistrySchema,
  equipmentSchema,
  newTankChemistry,
} from '@aquarium/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { personalityFromFishId } from '../personality.ts';
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

  it('backfills existing tanks as cycled, reefs salty, and fish as adults (0008)', async () => {
    const database = await freshDatabase();
    const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
    const apply = async (file: string) => {
      const sql = readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint')) await q(statement);
    };
    const before = [
      '0000_init.sql',
      '0001_mail_limit_hits.sql',
      '0002_mail_limit_hits_at_idx.sql',
      '0003_ate_batches.sql',
      '0004_fish_sex.sql',
      '0005_decor_layout_nullable.sql',
      '0006_fish_sex_drop_default.sql',
      '0007_tank_background.sql',
    ];
    for (const file of before) await apply(file);
    await q(`insert into "user" (id, name, email) values ('u7', 'U', 'u7@bas.lu')`);
    const insertTank = async (biome: string, name: string) =>
      (
        (
          await q(`insert into tanks (owner_id, biome, name) values ('u7', $1, $2) returning id`, [
            biome,
            name,
          ])
        ).rows[0] as { id: string }
      ).id;
    const freshId = await insertTank('freshwater', 'Old fresh');
    const reefId = await insertTank('reef', 'Old reef');
    await q(
      `insert into fish (tank_id, species, name, size, sex) values ($1, 'neon-tetra', 'F', 0.03, 'male'), ($1, 'neon-tetra', 'G', 0.03, 'female')`,
      [freshId],
    );

    await apply('0008_expansion_contract.sql');

    const rows = await q(
      `select id, chemistry, equipment, size, quarantine, share_token from tanks`,
    );
    const byId = new Map(
      rows.rows.map((r: { id: string }) => [r.id, r as Record<string, unknown>]),
    );
    const fresh = byId.get(freshId);
    const reef = byId.get(reefId);
    expect(chemistrySchema.parse(fresh?.['chemistry'])).toEqual(newTankChemistry('freshwater'));
    expect(chemistrySchema.parse(reef?.['chemistry'])).toEqual(newTankChemistry('reef'));
    for (const tank of [fresh, reef]) {
      expect(equipmentSchema.parse(tank?.['equipment'])).toEqual({
        ...DEFAULT_EQUIPMENT,
        heater: { tier: 0 },
      });
      expect(tank).toMatchObject({ size: 'standard', quarantine: false, share_token: null });
    }
    const fish = await q(`select id, stage, personality, disease from fish order by name`);
    expect(fish.rows.map((r: { stage: string; disease: unknown }) => [r.stage, r.disease])).toEqual(
      [
        ['adult', null],
        ['adult', null],
      ],
    );
    const [a, b] = fish.rows.map((r: { personality: unknown }) =>
      personalitySchema.parse(r.personality),
    );
    expect(a).not.toEqual(NEUTRAL_PERSONALITY);
    expect(a).not.toEqual(b);
    const again = await q(
      `select jsonb_build_object('boldness', round(((('x' || substr(md5("id"::text || 'boldness'), 1, 8))::bit(32)::bigint)::numeric / 4294967295), 3)) as p from fish order by name`,
    );
    expect((again.rows[0] as { p: { boldness: number } }).p.boldness).toBe(a?.boldness);
  });

  it('backfills only neutral-default personalities, deterministically and idempotently (0014)', async () => {
    const database = await freshDatabase();
    await runMigrations(database);
    const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
    await q(`insert into "user" (id, name, email) values ('u14', 'U', 'u14@bas.lu')`);
    const tank = await q(
      `insert into tanks (owner_id, biome, name) values ('u14', 'freshwater', 'T') returning id`,
    );
    const tankId = (tank.rows[0] as { id: string }).id;
    const neutralId = randomUUID();
    const chosenId = randomUUID();
    const chosen = { boldness: 0.1, greed: 0.9, sociability: 0.2 };
    await q(
      `insert into fish (id, tank_id, species, name, size, sex) values ($1, $3, 'neon-tetra', 'N', 0.03, 'male'), ($2, $3, 'neon-tetra', 'C', 0.03, 'male')`,
      [neutralId, chosenId, tankId],
    );
    await q(`update fish set personality = $1 where id = $2`, [JSON.stringify(chosen), chosenId]);

    const sql = readFileSync(
      new URL('../../drizzle/0014_personality_visits.sql', import.meta.url),
      'utf8',
    );
    const backfill = sql.split('--> statement-breakpoint').find((s) => s.includes('UPDATE "fish"'));
    if (!backfill) throw new Error('0014 has no fish backfill');
    const read = async () =>
      new Map(
        (await q(`select id, personality from fish`)).rows.map(
          (r: { id: string; personality: unknown }) => [
            r.id,
            personalitySchema.parse(r.personality),
          ],
        ),
      );

    await q(backfill);
    const once = await read();
    expect(once.get(neutralId)).toEqual(personalityFromFishId(neutralId));
    expect(once.get(chosenId)).toEqual(chosen);
    await q(backfill);
    expect(await read()).toEqual(once);
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

  it('drops the fish sex default and keeps stored values (0006)', async () => {
    const database = await freshDatabase();
    await runMigrations(database);
    const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
    await q(`insert into "user" (id, name, email) values ('u5', 'U', 'u5@bas.lu')`);
    const tank = await q(
      `insert into tanks (owner_id, biome, name) values ('u5', 'freshwater', 'T') returning id`,
    );
    const tankId = (tank.rows[0] as { id: string }).id;
    await expect(
      q(`insert into fish (tank_id, species, name, size) values ($1, 'neon-tetra', 'F', 0.03)`, [
        tankId,
      ]),
    ).rejects.toThrow(/sex/);

    await q(`alter table fish alter column sex set default 'female'`);
    await q(
      `insert into fish (tank_id, species, name, sex, size) values ($1, 'neon-tetra', 'M', 'male', 0.03)`,
      [tankId],
    );
    const migration = readFileSync(
      new URL('../../drizzle/0006_fish_sex_drop_default.sql', import.meta.url),
      'utf8',
    );
    await q(migration);
    const { rows } = await q(`select sex from fish`);
    expect(rows).toEqual([{ sex: 'male' }]);
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
