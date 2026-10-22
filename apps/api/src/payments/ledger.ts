import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '../db/index.ts';

type Tx = Parameters<Parameters<Database['db']['transaction']>[0]>[0];

export type PaymentReason = 'pack' | 'subscription' | 'clawback' | 'restore';

// Real-money rows are keyed (source, key) with no user in the index, so a replayed provider event
// finds its first run whatever happened to the account since. The wallet may go below zero here:
// a clawback after the Pearls were spent is allowed to, and only paid purchases are then blocked.
export async function postPaymentEntry(
  tx: Tx,
  entry: {
    userId: string | null;
    delta: number;
    reason: PaymentReason;
    itemRef: string;
    key: string;
    nowMs: number;
  },
): Promise<boolean> {
  const inserted = await tx
    .insert(schema.ledger)
    .values({
      userId: entry.userId,
      delta: entry.delta,
      reason: entry.reason,
      source: 'stripe',
      itemRef: entry.itemRef,
      idempotencyKey: entry.key,
      createdAt: new Date(entry.nowMs),
    })
    .onConflictDoNothing()
    .returning({ id: schema.ledger.id });
  if (inserted.length === 0) return false;
  if (entry.userId === null) return true;
  const updated = await tx
    .update(schema.wallet)
    .set({ balance: sql`${schema.wallet.balance} + ${entry.delta}` })
    .where(eq(schema.wallet.userId, entry.userId))
    .returning({ userId: schema.wallet.userId });
  if (updated.length === 0) throw new Error('wallet row missing; call lockWallet first');
  return true;
}

export async function userExists(tx: Tx, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  return row !== undefined;
}
