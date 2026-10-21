import { ONE_TIME_REF, type Economy, type LedgerEntry } from '@aquarium/shared';
import { and, eq, gte, like, lt, sql } from 'drizzle-orm';
import { schema, type Database } from './db/index.ts';
import { apiError, HttpError } from './errors.ts';

type Tx = Parameters<Parameters<Database['db']['transaction']>[0]>[0];
type LedgerRow = typeof schema.ledger.$inferSelect;

export const DAY_MS = 86_400_000;

// idempotencyKeySchema forbids ':', so a client can never send a key that collides with one the
// server made for its own rewards.
export const serverKey = (name: string): string => `server:${name}`;

export function toEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    userId: row.userId,
    delta: row.delta,
    reason: row.reason,
    source: row.source,
    itemRef: row.itemRef,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
  };
}

export const utcDay = (nowMs: number) => {
  const startMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return { startMs, endMs: startMs + DAY_MS, date: new Date(startMs).toISOString().slice(0, 10) };
};

// Every wallet mutation of one user runs under this lock, so a daily cap read and the credit that
// follows it can't interleave. Lock order everywhere: user row (FOR KEY SHARE), tank row, wallet.
// Account deletion locks the user row FOR UPDATE first and then cascades into tanks, so taking the
// user row before any tank row keeps both sides in the same order and rules out a deadlock.
export async function lockUserRow(tx: Tx, userId: string): Promise<void> {
  const [row] = await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .for('key share');
  if (!row) throw new HttpError(401, apiError('unauthenticated', 'Sign in required.'));
}

export async function lockWallet(
  tx: Tx,
  economy: Economy,
  userId: string,
  nowMs: number,
  userRowLocked = false,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`wallet:${userId}`}))`);
  if (!userRowLocked) await lockUserRow(tx, userId);
  const created = await tx
    .insert(schema.wallet)
    .values({ userId, balance: economy.grants.starting })
    .onConflictDoNothing()
    .returning({ userId: schema.wallet.userId });
  if (created.length === 0) return;
  await tx.insert(schema.ledger).values({
    userId,
    delta: economy.grants.starting,
    reason: 'grant',
    source: 'game',
    itemRef: 'grant:starting',
    idempotencyKey: serverKey('grant-starting'),
    createdAt: new Date(nowMs),
  });
}

export async function balanceOf(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ balance: schema.wallet.balance })
    .from(schema.wallet)
    .where(eq(schema.wallet.userId, userId));
  if (!row) throw new Error('wallet row missing; call lockWallet first');
  return row.balance;
}

async function playEntry(tx: Tx, userId: string, key: string): Promise<LedgerRow | undefined> {
  const [row] = await tx
    .select()
    .from(schema.ledger)
    .where(
      and(
        eq(schema.ledger.userId, userId),
        eq(schema.ledger.idempotencyKey, key),
        eq(schema.ledger.source, 'game'),
      ),
    );
  return row;
}

const keyReused = () =>
  new HttpError(
    409,
    apiError(
      'conflict',
      'This request key was already used for a different item. Send a new key for a new purchase.',
    ),
  );

export const insufficientPearls = (price: number, balance: number) =>
  new HttpError(
    402,
    apiError(
      'insufficient_pearls',
      `This costs ${price} Pearls and you have ${Math.max(balance, 0)}.`,
    ),
  );

export interface Charged {
  entry: LedgerEntry;
  balance: number;
  replayed: boolean;
}

// itemRef of a replay is compared up to `sameItem`, so a caller whose ref embeds a server-made id
// (a new tank) can still recognise its own purchase.
export async function findReplay(
  tx: Tx,
  userId: string,
  key: string,
  itemRef: string,
  sameItem: (stored: string, requested: string) => boolean = (a, b) => a === b,
): Promise<Charged | null> {
  const row = await playEntry(tx, userId, key);
  if (!row) return null;
  if (row.reason !== 'purchase' || row.itemRef === null || !sameItem(row.itemRef, itemRef)) {
    throw keyReused();
  }
  return { entry: toEntry(row), balance: await balanceOf(tx, userId), replayed: true };
}

// The one place Pearls leave a wallet. Claiming the key first makes a concurrent duplicate wait for
// the first request and then replay it; the conditional UPDATE is what keeps the balance from ever
// going below zero when two different purchases race.
export async function spend(
  tx: Tx,
  userId: string,
  purchase: { amount: number; itemRef: string; key: string; nowMs: number },
  sameItem?: (stored: string, requested: string) => boolean,
): Promise<Charged> {
  const { amount, itemRef, key, nowMs } = purchase;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`spend() needs a positive whole price, got ${amount}`);
  }
  const claimed = await tx
    .insert(schema.ledger)
    .values({
      userId,
      delta: -amount,
      reason: 'purchase',
      source: 'game',
      itemRef,
      idempotencyKey: key,
      createdAt: new Date(nowMs),
    })
    .onConflictDoNothing()
    .returning();
  const [row] = claimed;
  if (!row) {
    const replay = await findReplay(tx, userId, key, itemRef, sameItem);
    if (!replay) throw new Error('ledger insert conflicted but no entry holds the key');
    return replay;
  }
  const debited = await tx
    .update(schema.wallet)
    .set({ balance: sql`${schema.wallet.balance} - ${amount}` })
    .where(and(eq(schema.wallet.userId, userId), gte(schema.wallet.balance, amount)))
    .returning({ balance: schema.wallet.balance });
  const [after] = debited;
  if (!after) throw insufficientPearls(amount, await balanceOf(tx, userId));
  return { entry: toEntry(row), balance: after.balance, replayed: false };
}

// Server-made credits carry a key derived from what earned them, so doing the same thing twice
// credits once. Returns null when the key was already used.
export async function credit(
  tx: Tx,
  userId: string,
  grant: {
    amount: number;
    reason: 'earn' | 'grant';
    itemRef: string;
    key: string;
    nowMs: number;
  },
): Promise<{ entry: LedgerEntry; balance: number } | null> {
  const [row] = await tx
    .insert(schema.ledger)
    .values({
      userId,
      delta: grant.amount,
      reason: grant.reason,
      source: 'game',
      itemRef: grant.itemRef,
      idempotencyKey: grant.key,
      createdAt: new Date(grant.nowMs),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  const [after] = await tx
    .update(schema.wallet)
    .set({ balance: sql`${schema.wallet.balance} + ${grant.amount}` })
    .where(eq(schema.wallet.userId, userId))
    .returning({ balance: schema.wallet.balance });
  if (!after) throw new Error('wallet row missing; call lockWallet first');
  return { entry: toEntry(row), balance: after.balance };
}

export async function earnedToday(
  tx: Tx,
  userId: string,
  itemRefPrefix: string,
  nowMs: number,
): Promise<number> {
  const { startMs, endMs } = utcDay(nowMs);
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${schema.ledger.delta}), 0)::int` })
    .from(schema.ledger)
    .where(
      and(
        eq(schema.ledger.userId, userId),
        eq(schema.ledger.reason, 'earn'),
        like(schema.ledger.itemRef, `${itemRefPrefix}%`),
        gte(schema.ledger.createdAt, new Date(startMs)),
        lt(schema.ledger.createdAt, new Date(endMs)),
      ),
    );
  return row?.total ?? 0;
}

export async function hasKey(tx: Tx, userId: string, key: string): Promise<boolean> {
  return (await playEntry(tx, userId, key)) !== undefined;
}

export async function owns(tx: Tx, userId: string, itemRef: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.ledger.id })
    .from(schema.ledger)
    .where(
      and(
        eq(schema.ledger.userId, userId),
        eq(schema.ledger.reason, 'purchase'),
        eq(schema.ledger.itemRef, itemRef),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// A refund wins a timestamp tie: a refund needs its purchase first, and a rebuy needs a later tick.
export async function ownedRefs(tx: Tx, userId: string): Promise<string[]> {
  const result = await tx.execute<{ item_ref: string }>(sql`
    select item_ref from (
      select distinct on (item_ref) item_ref, reason
      from ledger
      where user_id = ${userId} and source = 'game' and reason in ('purchase', 'refund') and item_ref ~ ${ONE_TIME_REF.source}
      order by item_ref, created_at desc, (reason = 'refund') desc, id desc
    ) latest
    where reason = 'purchase'
    order by item_ref
  `);
  return result.rows.map((r) => r.item_ref);
}
