import { lt, sql } from 'drizzle-orm';
import { schema, type Database } from './db/index.ts';

const HOUR_MS = 60 * 60_000;

export async function pruneExpired({ db }: Database): Promise<{ sessions: number }> {
  const sessions = await db
    .delete(schema.session)
    .where(lt(schema.session.expiresAt, sql`now()`))
    .returning({ id: schema.session.id });
  await db.delete(schema.verification).where(lt(schema.verification.expiresAt, sql`now()`));
  return { sessions: sessions.length };
}

export function startMaintenance(database: Database): () => void {
  const run = () =>
    pruneExpired(database).catch((err: unknown) => {
      console.error('maintenance failed:', err instanceof Error ? err.message : 'unknown');
    });
  void run();
  const timer = setInterval(run, HOUR_MS);
  timer.unref();
  return () => clearInterval(timer);
}
