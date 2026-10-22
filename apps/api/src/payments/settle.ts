import type { Economy } from '@aquarium/shared';
import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import { schema, type Database } from '../db/index.ts';
import { lockWallet } from '../wallet.ts';
import { postPaymentEntry, userExists } from './ledger.ts';
import type { PaymentProvider } from './provider.ts';

type Tx = Parameters<Parameters<Database['db']['transaction']>[0]>[0];
type ChargeRow = typeof schema.paymentCharges.$inferSelect;

export interface Receipt {
  chargeId: string;
  userId: string;
  description: string;
  amountCents: number;
  pearls: number | null;
  consentAt: Date | null;
}

export interface SettleDeps {
  database: Database;
  economy: Economy;
  provider: PaymentProvider;
  now: () => number;
  log: (message: string, context?: Record<string, string | number>) => void;
  logError: (message: string, context?: Record<string, string | number>) => void;
}

const idOf = (ref: string | { id: string } | null | undefined): string | null =>
  ref === null || ref === undefined ? null : typeof ref === 'string' ? ref : ref.id;

const date = (seconds: number) => new Date(seconds * 1000);

const meta = (m: Stripe.Metadata | null | undefined, key: string): string | undefined =>
  m?.[key] || undefined;

const consentOf = (m: Stripe.Metadata | null | undefined): Date | null | undefined => {
  if (meta(m, 'consent_immediate_delivery') !== 'true') return undefined;
  if (meta(m, 'consent_withdrawal_waiver') !== 'true') return undefined;
  const at = new Date(meta(m, 'consent_at') ?? '');
  return Number.isNaN(at.getTime()) ? null : at;
};

// The price and Pearls promised at checkout travel in the session metadata, which only the server
// sets, so a price list that changed while the buyer was paying cannot strand a paid purchase.
const promiseOf = (
  m: Stripe.Metadata | null | undefined,
): { priceCents: number; pearls: number } | null => {
  const priceCents = Number(meta(m, 'price_cents'));
  const pearls = Number(meta(m, 'pearls'));
  return Number.isInteger(priceCents) && priceCents > 0 && Number.isInteger(pearls) && pearls > 0
    ? { priceCents, pearls }
    : null;
};

export function receiptOf(economy: Economy, charge: ChargeRow): Receipt | null {
  if (!charge.userId) return null;
  const base = {
    chargeId: charge.id,
    userId: charge.userId,
    amountCents: charge.amountCents,
    consentAt: charge.consentAt,
  };
  return charge.kind === 'pack'
    ? { ...base, description: `${charge.packPearls ?? 0} Pearls`, pearls: charge.packPearls }
    : {
        ...base,
        description: `${economy.subscription.id} subscription, first month`,
        pearls: null,
      };
}

const BILLABLE = ['active', 'trialing', 'past_due', 'unpaid'] as const;
const NOT_YET_PAID = ['incomplete'] as const;

// Events are at-least-once and unordered, so every branch is keyed on the provider's own object id
// (Checkout Session, invoice, refund, dispute) and a replay changes nothing. An event the app did
// not create (no user in its metadata) is acknowledged and ignored; a mismatch with the checkout's
// promise throws, so the provider retries and the error stays visible instead of crediting wrongly.
export async function settleEvent(deps: SettleDeps, event: Stripe.Event): Promise<Receipt | null> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return creditPack(deps, event.data.object);
    case 'invoice.paid':
      return recordInvoicePaid(deps, event.data.object);
    case 'invoice_payment.paid':
      await linkInvoicePayment(deps, event.data.object);
      return null;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await syncSubscription(deps, event.data.object);
      return null;
    case 'refund.created':
    case 'refund.updated':
      await applyRefund(deps, event.data.object);
      return null;
    case 'charge.dispute.closed':
    case 'charge.dispute.updated':
    case 'charge.dispute.funds_reinstated':
      await applyDispute(deps, event.data.object);
      return null;
    default:
      return null;
  }
}

async function creditPack(
  deps: SettleDeps,
  session: Stripe.Checkout.Session,
): Promise<Receipt | null> {
  if (session.mode !== 'payment' || session.payment_status !== 'paid') return null;
  const userId = meta(session.metadata, 'user_id');
  const packId = meta(session.metadata, 'pack_id');
  const consent = consentOf(session.metadata);
  const promised = promiseOf(session.metadata);
  if (!userId || !packId || consent === undefined) {
    deps.log('checkout session without our metadata ignored', { session: session.id });
    return null;
  }
  if (promised === null) {
    deps.logError('paid checkout session without a price promise was not credited', {
      session: session.id,
    });
    return null;
  }
  const pack = { id: packId, ...promised };
  if (session.amount_total !== pack.priceCents || session.currency !== 'eur') {
    throw new Error(
      `session ${session.id} paid ${session.amount_total} ${session.currency}, pack ${pack.id} promised ${pack.priceCents} eur`,
    );
  }
  const nowMs = deps.now();

  return deps.database.db.transaction(async (tx) => {
    const present = await userExists(tx, userId);
    if (present) await lockWallet(tx, deps.economy, userId, nowMs);
    const owner = present ? userId : null;

    const posted = await postPaymentEntry(tx, {
      userId: owner,
      delta: pack.pearls,
      reason: 'pack',
      itemRef: `pack:${pack.id}`,
      key: `checkout:${session.id}`,
      nowMs,
    });
    if (!posted) return null;

    await tx.insert(schema.paymentCharges).values({
      id: session.id,
      kind: 'pack',
      userId: owner,
      paymentIntentId: idOf(session.payment_intent),
      amountCents: pack.priceCents,
      packId: pack.id,
      packPearls: pack.pearls,
      consentAt: consent,
      receiptPending: owner !== null,
      createdAt: new Date(nowMs),
    });
    if (!owner) return null;
    return {
      chargeId: session.id,
      userId: owner,
      description: `${pack.pearls} Pearls`,
      amountCents: pack.priceCents,
      pearls: pack.pearls,
      consentAt: consent,
    };
  });
}

async function linkInvoicePayment(deps: SettleDeps, payment: Stripe.InvoicePayment): Promise<void> {
  const paymentIntent = idOf(payment.payment.payment_intent);
  const invoice = idOf(payment.invoice);
  if (payment.payment.type !== 'payment_intent' || !paymentIntent || !invoice) return;
  await deps.database.db
    .insert(schema.paymentIntentLinks)
    .values({ paymentIntentId: paymentIntent, invoiceId: invoice })
    .onConflictDoNothing();
}

function paidWindow(invoice: Stripe.Invoice): { start: Date; end: Date } {
  const lines = invoice.lines?.data ?? [];
  if (lines.length === 0)
    return { start: date(invoice.period_start), end: date(invoice.period_end) };
  return {
    start: date(Math.min(...lines.map((l) => l.period.start))),
    end: date(Math.max(...lines.map((l) => l.period.end))),
  };
}

async function recordInvoicePaid(
  deps: SettleDeps,
  invoice: Stripe.Invoice,
): Promise<Receipt | null> {
  const details = invoice.parent?.subscription_details;
  const subscriptionId = idOf(details?.subscription);
  const userId = meta(details?.metadata, 'user_id');
  if (
    !subscriptionId ||
    !userId ||
    meta(details?.metadata, 'offer_id') !== deps.economy.subscription.id
  ) {
    return null;
  }
  if (invoice.amount_paid <= 0) return null;
  const invoiceId = invoice.id;
  if (!invoiceId) throw new Error('a paid invoice event arrived without an invoice id');
  const consent = consentOf(details?.metadata);
  const window = paidWindow(invoice);
  const nowMs = deps.now();

  // A subscription nobody can claim (the account is gone, or the user already has another paid
  // one from a second checkout) must not keep billing: it is cancelled and its payment refunded,
  // after the transaction and on every redelivery until the provider accepted both.
  const outcome = await deps.database.db.transaction(async (tx) => {
    const present = await userExists(tx, userId);
    if (present) await lockWallet(tx, deps.economy, userId, nowMs);
    const owner = present ? userId : null;

    const created = await tx
      .insert(schema.paymentCharges)
      .values({
        id: invoiceId,
        kind: 'invoice',
        userId: owner,
        amountCents: invoice.amount_paid,
        subscriptionId,
        periodStart: window.start,
        periodEnd: window.end,
        consentAt: consent ?? null,
        createdAt: new Date(nowMs),
      })
      .onConflictDoNothing()
      .returning({ id: schema.paymentCharges.id });
    const existing = await lockSubscription(tx, subscriptionId);
    if (created.length === 0) {
      const neverGranted = existing ? existing.paidEnd === null : owner === null;
      return { receipt: null, unclaimed: neverGranted };
    }

    const [rival] = owner
      ? await tx
          .select({ id: schema.clubSubscriptions.id })
          .from(schema.clubSubscriptions)
          .where(
            and(
              eq(schema.clubSubscriptions.userId, owner),
              ne(schema.clubSubscriptions.id, subscriptionId),
              inArray(schema.clubSubscriptions.status, [...BILLABLE]),
              gt(schema.clubSubscriptions.paidEnd, new Date(nowMs)),
              eq(schema.clubSubscriptions.paidRevoked, false),
            ),
          )
          .limit(1)
      : [];
    if (rival || !owner) {
      // No paid window is stored, so this subscription never earns the daily Pearls.
      await tx
        .insert(schema.clubSubscriptions)
        .values({
          id: subscriptionId,
          userId: owner,
          status: 'active',
          statusEventAt: new Date(nowMs),
        })
        .onConflictDoNothing();
      return { receipt: null, unclaimed: true };
    }

    if (!existing) {
      await tx.insert(schema.clubSubscriptions).values({
        id: subscriptionId,
        userId: owner,
        status: 'active',
        statusEventAt: new Date(nowMs),
        paidInvoiceId: invoiceId,
        paidStart: window.start,
        paidEnd: window.end,
      });
    } else if (!existing.paidEnd || window.end > existing.paidEnd) {
      await tx
        .update(schema.clubSubscriptions)
        .set({
          paidInvoiceId: invoiceId,
          paidStart: window.start,
          paidEnd: window.end,
          paidRevoked: false,
          userId: existing.userId ?? owner,
          ...(existing.status === 'incomplete'
            ? { status: 'active', statusEventAt: new Date(nowMs) }
            : {}),
        })
        .where(eq(schema.clubSubscriptions.id, subscriptionId));
    }

    const receipt: Receipt | null =
      owner && invoice.billing_reason === 'subscription_create'
        ? {
            chargeId: invoiceId,
            userId: owner,
            description: `${deps.economy.subscription.id} subscription, first month`,
            amountCents: invoice.amount_paid,
            pearls: null,
            consentAt: consent ?? null,
          }
        : null;
    if (receipt) {
      await tx
        .update(schema.paymentCharges)
        .set({ receiptPending: true })
        .where(eq(schema.paymentCharges.id, invoiceId));
    }
    return { receipt, unclaimed: owner === null };
  });

  if (outcome.unclaimed) {
    await deps.provider.cancelSubscriptionNow(subscriptionId);
    await deps.provider.refundInvoice(invoiceId);
    deps.log('unclaimed subscription cancelled and refunded', { invoice: invoiceId });
  }
  return outcome.receipt;
}

async function lockSubscription(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(schema.clubSubscriptions)
    .where(eq(schema.clubSubscriptions.id, id))
    .for('update');
  return row;
}

async function syncSubscription(
  deps: SettleDeps,
  subscription: Stripe.Subscription,
): Promise<void> {
  const userId = meta(subscription.metadata, 'user_id');
  if (!userId || meta(subscription.metadata, 'offer_id') !== deps.economy.subscription.id) return;

  // Event timestamps have one-second resolution and Stripe does not order a subscription's events,
  // so the payload is only a trigger: the status stored is what Stripe says it is now. The moment
  // the question was asked orders concurrent answers.
  const askedAt = new Date(deps.now());
  const current = await deps.provider.retrieveSubscription(subscription.id);

  const owner = await deps.database.db.transaction(async (tx) => {
    const present = (await userExists(tx, userId)) ? userId : null;
    await tx
      .insert(schema.clubSubscriptions)
      .values({
        id: subscription.id,
        userId: present,
        status: 'incomplete',
        statusEventAt: new Date(0),
      })
      .onConflictDoNothing();
    const row = await lockSubscription(tx, subscription.id);
    if (row && row.statusEventAt <= askedAt) {
      await tx
        .update(schema.clubSubscriptions)
        .set({
          status: current.status,
          cancelAtPeriodEnd: current.cancelAtPeriodEnd,
          statusEventAt: askedAt,
          userId: row.userId ?? present,
        })
        .where(eq(schema.clubSubscriptions.id, subscription.id));
    }
    return present;
  });

  const stillRunning = [...BILLABLE, ...NOT_YET_PAID] as string[];
  if (owner === null && stillRunning.includes(current.status)) {
    await deps.provider.cancelSubscriptionNow(subscription.id);
    deps.log('subscription of a deleted account cancelled', { subscription: subscription.id });
  }
}

async function findCharge(tx: Tx, paymentIntentId: string): Promise<ChargeRow | undefined> {
  const [direct] = await tx
    .select()
    .from(schema.paymentCharges)
    .where(eq(schema.paymentCharges.paymentIntentId, paymentIntentId));
  if (direct) return direct;
  const [linked] = await tx
    .select({ charge: schema.paymentCharges })
    .from(schema.paymentIntentLinks)
    .innerJoin(
      schema.paymentCharges,
      eq(schema.paymentCharges.id, schema.paymentIntentLinks.invoiceId),
    )
    .where(eq(schema.paymentIntentLinks.paymentIntentId, paymentIntentId));
  return linked?.charge;
}

async function lockCharge(tx: Tx, id: string): Promise<ChargeRow> {
  const [row] = await tx
    .select()
    .from(schema.paymentCharges)
    .where(eq(schema.paymentCharges.id, id))
    .for('update');
  if (!row) throw new Error(`charge ${id} disappeared`);
  return row;
}

async function pearlsAtStake(tx: Tx, charge: ChargeRow): Promise<number> {
  if (charge.kind === 'pack') return charge.packPearls ?? 0;
  if (!charge.subscriptionId || !charge.periodStart || !charge.periodEnd) return 0;
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${schema.ledger.delta}), 0)::int` })
    .from(schema.ledger)
    .where(
      and(
        eq(schema.ledger.source, 'stripe'),
        eq(schema.ledger.reason, 'subscription'),
        eq(schema.ledger.itemRef, `sub:${charge.subscriptionId}`),
        sql`${schema.ledger.createdAt} >= ${charge.periodStart}`,
        sql`${schema.ledger.createdAt} < ${charge.periodEnd}`,
      ),
    );
  return row?.total ?? 0;
}

async function takenBack(tx: Tx, chargeId: string): Promise<{ cents: number; pearls: number }> {
  const [refunds] = await tx
    .select({
      cents: sql<number>`coalesce(sum(${schema.paymentRefunds.cents}), 0)::int`,
      pearls: sql<number>`coalesce(sum(${schema.paymentRefunds.pearls}), 0)::int`,
    })
    .from(schema.paymentRefunds)
    .where(eq(schema.paymentRefunds.chargeId, chargeId));
  const [disputes] = await tx
    .select({
      cents: sql<number>`coalesce(sum(${schema.paymentDisputes.cents}), 0)::int`,
      pearls: sql<number>`coalesce(sum(${schema.paymentDisputes.pearls}), 0)::int`,
    })
    .from(schema.paymentDisputes)
    .where(
      and(eq(schema.paymentDisputes.chargeId, chargeId), eq(schema.paymentDisputes.state, 'lost')),
    );
  return {
    cents: (refunds?.cents ?? 0) + (disputes?.cents ?? 0),
    pearls: (refunds?.pearls ?? 0) + (disputes?.pearls ?? 0),
  };
}

// Cumulative and capped: what is owed back after all refunds and lost disputes so far, minus what
// earlier ones already took. A refund never takes more than the Pearls the payment gave.
async function clawbackOwed(
  tx: Tx,
  charge: ChargeRow,
): Promise<{ pearls: number; covered: boolean }> {
  const taken = await takenBack(tx, charge.id);
  if (charge.amountCents <= 0) return { pearls: 0, covered: false };
  const cents = Math.min(taken.cents, charge.amountCents);
  const base = await pearlsAtStake(tx, charge);
  const target = Math.floor((base * cents) / charge.amountCents);
  return {
    pearls: Math.max(0, target - taken.pearls),
    covered: taken.cents >= charge.amountCents,
  };
}

async function setPeriodRevoked(tx: Tx, charge: ChargeRow, revoked: boolean): Promise<void> {
  if (charge.kind !== 'invoice' || !charge.subscriptionId) return;
  await tx
    .update(schema.clubSubscriptions)
    .set({ paidRevoked: revoked })
    .where(
      and(
        eq(schema.clubSubscriptions.id, charge.subscriptionId),
        eq(schema.clubSubscriptions.paidInvoiceId, charge.id),
      ),
    );
}

// An invoice's payment intent is linked by a separate event that may arrive after the refund. The
// error makes the provider redeliver with backoff until the link exists; the account is dedicated
// to this app, so a payment nobody here took is not expected.
const unknownPayment = (kind: string, id: string, paymentIntent: string) =>
  new Error(
    `${kind} ${id} names payment intent ${paymentIntent} that is not recorded (yet); retry later`,
  );

const refOf = (charge: ChargeRow) =>
  charge.kind === 'pack' ? `pack:${charge.packId ?? ''}` : `sub:${charge.subscriptionId ?? ''}`;

async function lockForAdjustment(deps: SettleDeps, tx: Tx, charge: ChargeRow): Promise<ChargeRow> {
  if (charge.userId) await lockWallet(tx, deps.economy, charge.userId, deps.now());
  return lockCharge(tx, charge.id);
}

async function applyRefund(deps: SettleDeps, refund: Stripe.Refund): Promise<void> {
  if (refund.status !== 'succeeded') return;
  const paymentIntent = idOf(refund.payment_intent);
  if (!paymentIntent) return;

  await deps.database.db.transaction(async (tx) => {
    const found = await findCharge(tx, paymentIntent);
    if (!found) throw unknownPayment('refund', refund.id, paymentIntent);
    const charge = await lockForAdjustment(deps, tx, found);
    const recorded = await tx
      .insert(schema.paymentRefunds)
      .values({ refundId: refund.id, chargeId: charge.id, cents: refund.amount, pearls: 0 })
      .onConflictDoNothing()
      .returning({ id: schema.paymentRefunds.refundId });
    if (recorded.length === 0) return;

    const owed = await clawbackOwed(tx, charge);
    if (owed.pearls > 0) {
      await tx
        .update(schema.paymentRefunds)
        .set({ pearls: owed.pearls })
        .where(eq(schema.paymentRefunds.refundId, refund.id));
      await postPaymentEntry(tx, {
        userId: charge.userId,
        delta: -owed.pearls,
        reason: 'clawback',
        itemRef: refOf(charge),
        key: `refund:${refund.id}`,
        nowMs: deps.now(),
      });
    }
    if (owed.covered) await setPeriodRevoked(tx, charge, true);
  });
}

// A dispute is terminal once lost or won, except lost then won (funds returned), which restores
// exactly what the loss took. A won event that arrives first leaves a marker so a late, stale lost
// event cannot claw anything back.
async function applyDispute(deps: SettleDeps, dispute: Stripe.Dispute): Promise<void> {
  if (dispute.status !== 'lost' && dispute.status !== 'won') return;
  const paymentIntent = idOf(dispute.payment_intent);
  if (!paymentIntent) return;

  await deps.database.db.transaction(async (tx) => {
    const found = await findCharge(tx, paymentIntent);
    if (!found) throw unknownPayment('dispute', dispute.id, paymentIntent);
    const charge = await lockForAdjustment(deps, tx, found);
    const [existing] = await tx
      .select()
      .from(schema.paymentDisputes)
      .where(eq(schema.paymentDisputes.disputeId, dispute.id));

    if (dispute.status === 'lost') {
      if (existing) return;
      await tx.insert(schema.paymentDisputes).values({
        disputeId: dispute.id,
        chargeId: charge.id,
        state: 'lost',
        cents: dispute.amount,
        pearls: 0,
      });
      const owed = await clawbackOwed(tx, charge);
      if (owed.pearls > 0) {
        await tx
          .update(schema.paymentDisputes)
          .set({ pearls: owed.pearls })
          .where(eq(schema.paymentDisputes.disputeId, dispute.id));
        await postPaymentEntry(tx, {
          userId: charge.userId,
          delta: -owed.pearls,
          reason: 'clawback',
          itemRef: refOf(charge),
          key: `dispute-lost:${dispute.id}`,
          nowMs: deps.now(),
        });
      }
      if (owed.covered) await setPeriodRevoked(tx, charge, true);
      return;
    }

    if (!existing) {
      await tx.insert(schema.paymentDisputes).values({
        disputeId: dispute.id,
        chargeId: charge.id,
        state: 'won',
        cents: 0,
        pearls: 0,
      });
      return;
    }
    if (existing.state === 'won') return;
    await tx
      .update(schema.paymentDisputes)
      .set({ state: 'won', updatedAt: new Date(deps.now()) })
      .where(eq(schema.paymentDisputes.disputeId, dispute.id));
    if (existing.pearls > 0) {
      await postPaymentEntry(tx, {
        userId: charge.userId,
        delta: existing.pearls,
        reason: 'restore',
        itemRef: refOf(charge),
        key: `dispute-won:${dispute.id}`,
        nowMs: deps.now(),
      });
    }
    const taken = await takenBack(tx, charge.id);
    if (taken.cents < charge.amountCents) await setPeriodRevoked(tx, charge, false);
  });
}
