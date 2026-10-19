import { HANDLE_COOLDOWN_DAYS, VISIT_WINDOW_DAYS } from '@aquarium/shared';
import { lt, sql } from 'drizzle-orm';
import { schema, type Database } from './db/index.ts';

const HOUR_MS = 60 * 60_000;

export async function pruneExpired({ db }: Database): Promise<{ sessions: number }> {
  const sessions = await db
    .delete(schema.session)
    .where(lt(schema.session.expiresAt, sql`now()`))
    .returning({ id: schema.session.id });
  await db.delete(schema.verification).where(lt(schema.verification.expiresAt, sql`now()`));
  await db
    .delete(schema.mailLimitHits)
    .where(lt(schema.mailLimitHits.at, sql`now() - interval '1 day'`));
  await db
    .delete(schema.ateBatches)
    .where(lt(schema.ateBatches.createdAt, sql`now() - interval '1 day'`));
  await db.delete(schema.auditLog).where(lt(schema.auditLog.at, sql`now() - interval '180 days'`));
  await db
    .delete(schema.tankVisits)
    .where(lt(schema.tankVisits.day, sql`current_date - ${VISIT_WINDOW_DAYS - 1}::int`));
  await db
    .delete(schema.releasedHandles)
    .where(
      lt(
        schema.releasedHandles.releasedAt,
        sql`now() - make_interval(days => ${HANDLE_COOLDOWN_DAYS})`,
      ),
    );
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
