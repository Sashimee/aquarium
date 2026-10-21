import { HANDLE_COOLDOWN_DAYS, VISIT_WINDOW_DAYS } from '@aquarium/shared';
import { lt } from 'drizzle-orm';
import { schema, type Database } from './db/index.ts';
import type { Clock } from './clock.ts';
import { settleWeeks } from './gallery.ts';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export async function pruneExpired({ db }: Database, clock: Clock): Promise<{ sessions: number }> {
  const now = clock.now();
  const ago = (ms: number) => new Date(now - ms);
  const sessions = await db
    .delete(schema.session)
    .where(lt(schema.session.expiresAt, new Date(now)))
    .returning({ id: schema.session.id });
  await db.delete(schema.verification).where(lt(schema.verification.expiresAt, new Date(now)));
  await db.delete(schema.mailLimitHits).where(lt(schema.mailLimitHits.at, ago(DAY_MS)));
  await db.delete(schema.ateBatches).where(lt(schema.ateBatches.createdAt, ago(DAY_MS)));
  await db.delete(schema.auditLog).where(lt(schema.auditLog.at, ago(180 * DAY_MS)));
  const oldestVisitDay = ago((VISIT_WINDOW_DAYS - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  await db.delete(schema.tankVisits).where(lt(schema.tankVisits.day, oldestVisitDay));
  await db.delete(schema.tankVotes).where(lt(schema.tankVotes.weekStart, ago(90 * DAY_MS)));
  await db
    .delete(schema.releasedHandles)
    .where(lt(schema.releasedHandles.releasedAt, ago(HANDLE_COOLDOWN_DAYS * DAY_MS)));
  return { sessions: sessions.length };
}

export function startMaintenance(database: Database, clock: Clock): () => void {
  const report = (err: unknown) => {
    console.error('maintenance failed:', err instanceof Error ? err.message : 'unknown');
  };
  const run = () => {
    void settleWeeks(database, clock.now()).catch(report);
    void pruneExpired(database, clock).catch(report);
  };
  run();
  const timer = setInterval(run, HOUR_MS);
  timer.unref();
  return () => clearInterval(timer);
}
