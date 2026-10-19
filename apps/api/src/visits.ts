import { VISIT_WINDOW_DAYS } from '@aquarium/shared';
import { and, count, eq, gte, lt } from 'drizzle-orm';
import { schema, type Database } from './db/index.ts';

type Tx = Parameters<Parameters<Database['db']['transaction']>[0]>[0];

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 60;

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export async function recordVisit(tx: Tx, tankId: string, nowMs: number): Promise<void> {
  await tx
    .insert(schema.tankVisits)
    .values({ tankId, day: utcDay(nowMs) })
    .onConflictDoNothing();
  await tx
    .delete(schema.tankVisits)
    .where(
      and(
        eq(schema.tankVisits.tankId, tankId),
        lt(schema.tankVisits.day, utcDay(nowMs - RETENTION_DAYS * DAY_MS)),
      ),
    );
}

export async function countRecentVisitDays(tx: Tx, tankId: string, nowMs: number): Promise<number> {
  const [row] = await tx
    .select({ days: count() })
    .from(schema.tankVisits)
    .where(
      and(
        eq(schema.tankVisits.tankId, tankId),
        gte(schema.tankVisits.day, utcDay(nowMs - (VISIT_WINDOW_DAYS - 1) * DAY_MS)),
      ),
    );
  return row?.days ?? 0;
}
