import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.ts';

export { schema };

export interface Database {
  db: NodePgDatabase<typeof schema>;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function connect(databaseUrl: string): Database {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
  });
  pool.on('error', (err) => {
    console.error('postgres pool error:', err.message);
  });
  return {
    db: drizzle(pool, { schema }),
    pool,
    close: () => pool.end(),
  };
}

// Resolves to apps/api/drizzle from both src/db/ and the bundled dist/.
const MIGRATIONS = fileURLToPath(
  new URL(
    import.meta.url.endsWith('/src/db/index.ts') ? '../../drizzle' : '../drizzle',
    import.meta.url,
  ),
);

export async function runMigrations({ db }: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS });
}
