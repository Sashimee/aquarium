import type { Economy } from '@aquarium/shared';
import { and, desc, eq, gt, lte } from 'drizzle-orm';
import { schema, type Database } from '../db/index.ts';
import { utcDay } from '../wallet.ts';
import { postPaymentEntry } from './ledger.ts';

type Tx = Parameters<Parameters<Database['db']['transaction']>[0]>[0];

// The caller holds the wallet lock (lockWallet). The ledger key carries subscription id and UTC
// day, so the first visit of a day pays and every later one finds the key taken, even across
// instances. Returns the Pearls granted, or 0.
export async function claimClubGrant(
  tx: Tx,
  economy: Economy,
  userId: string,
  nowMs: number,
): Promise<number> {
  const now = new Date(nowMs);
  const [subscription] = await tx
    .select({ id: schema.clubSubscriptions.id })
    .from(schema.clubSubscriptions)
    .where(
      and(
        eq(schema.clubSubscriptions.userId, userId),
        eq(schema.clubSubscriptions.status, 'active'),
        eq(schema.clubSubscriptions.paidRevoked, false),
        lte(schema.clubSubscriptions.paidStart, now),
        gt(schema.clubSubscriptions.paidEnd, now),
      ),
    )
    .orderBy(desc(schema.clubSubscriptions.paidEnd))
    .limit(1);
  if (!subscription) return 0;

  const amount = economy.subscription.pearlsPerDay;
  const posted = await postPaymentEntry(tx, {
    userId,
    delta: amount,
    reason: 'subscription',
    itemRef: `sub:${subscription.id}`,
    key: `sub:${subscription.id}:${utcDay(nowMs).date}`,
    nowMs,
  });
  return posted ? amount : 0;
}
