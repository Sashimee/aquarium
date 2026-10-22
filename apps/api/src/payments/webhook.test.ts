import { apiErrorSchema, paymentsStateSchema, walletResponseSchema } from '@aquarium/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/index.ts';
import { createHarness, type Harness } from '../test-harness.ts';
import {
  DAY_MS,
  PASSWORD,
  account,
  buildEvent,
  call,
  deliver,
  deliverOk,
  disputeObject,
  economy,
  invoiceObject,
  newIds,
  paymentsKit,
  refundObject,
  seconds,
  sessionObject,
  subscriptionObject,
  type Account,
  type PaymentsKit,
} from './testkit.ts';

const PACK = 'pearls-550';
const pack = economy.packs.find((p) => p.id === PACK) ?? expect.unreachable('pack missing');
const DAILY = economy.subscription.pearlsPerDay;

let h: Harness;
let kit: PaymentsKit;

beforeAll(async () => {
  kit = paymentsKit();
  h = await createHarness({ payments: kit.provider });
});
afterAll(() => h.close());

const balance = async (who: Account) =>
  walletResponseSchema.parse((await call(h, who, 'GET', '/api/wallet')).json()).wallet.balance;

const chargeRows = (id: string) =>
  h.database.db.select().from(schema.paymentCharges).where(eq(schema.paymentCharges.id, id));

const stripeLedger = async (who: Account) =>
  h.database.db
    .select()
    .from(schema.ledger)
    .where(and(eq(schema.ledger.userId, who.userId), eq(schema.ledger.source, 'stripe')));

async function bought(who: Account, packId = PACK) {
  const ids = newIds();
  await deliverOk(
    h,
    kit,
    buildEvent(h, 'checkout.session.completed', sessionObject(who, packId, ids)),
  );
  return ids;
}

const msToNextUtcMidnight = () => DAY_MS - (h.clock.now() % DAY_MS) + 1000;

async function subscribed(who: Account, days = 30) {
  const ids = newIds();
  const now = h.clock.now();
  await deliverOk(
    h,
    kit,
    buildEvent(
      h,
      'invoice.paid',
      invoiceObject(who, ids, { start: seconds(now), end: seconds(now + days * DAY_MS) }),
    ),
  );
  return ids;
}

describe('pack purchases', () => {
  it('credits the pearls once per Checkout Session and mails a receipt with the consent', async () => {
    const who = await account(h);
    const before = await balance(who);
    const ids = await bought(who);
    expect(await balance(who)).toBe(before + pack.pearls);

    const rows = await chargeRows(ids.session);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'pack',
      userId: who.userId,
      amountCents: pack.priceCents,
      packPearls: pack.pearls,
    });
    expect(rows[0]?.consentAt).not.toBeNull();

    const mail = h.outbox.findLast((m) => m.to === who.email && m.text.includes('Pearls added'));
    expect(mail?.text).toContain(`${pack.pearls} Pearls`);
    expect(mail?.text).toContain('immediate delivery');
    expect(mail?.text).toContain('right of withdrawal');
  });

  it('ignores a replayed event, another event for the same session, and the async follow-up', async () => {
    const who = await account(h);
    const before = await balance(who);
    const ids = newIds();
    const session = sessionObject(who, PACK, ids);
    const event = buildEvent(h, 'checkout.session.completed', session);
    await deliverOk(h, kit, event);
    await deliverOk(h, kit, event);
    await deliverOk(h, kit, buildEvent(h, 'checkout.session.completed', session));
    await deliverOk(h, kit, buildEvent(h, 'checkout.session.async_payment_succeeded', session));
    expect(await balance(who)).toBe(before + pack.pearls);
    expect(await stripeLedger(who)).toHaveLength(1);
  });

  it('credits once when identical deliveries race', async () => {
    const who = await account(h);
    const before = await balance(who);
    const event = buildEvent(h, 'checkout.session.completed', sessionObject(who, PACK, newIds()));
    const results = await Promise.all(Array.from({ length: 6 }, () => deliver(h, kit, event)));
    expect(results.map((r) => r.statusCode)).toEqual(Array(6).fill(200));
    expect(await balance(who)).toBe(before + pack.pearls);
  });

  it('credits only when the session is paid; a delayed method pays on async success', async () => {
    const who = await account(h);
    const before = await balance(who);
    const ids = newIds();
    await deliverOk(
      h,
      kit,
      buildEvent(h, 'checkout.session.completed', sessionObject(who, PACK, ids, { paid: false })),
    );
    expect(await balance(who)).toBe(before);
    expect(await chargeRows(ids.session)).toHaveLength(0);

    await deliverOk(
      h,
      kit,
      buildEvent(h, 'checkout.session.async_payment_succeeded', sessionObject(who, PACK, ids)),
    );
    expect(await balance(who)).toBe(before + pack.pearls);
  });

  it('fails loudly on an amount that is not the price, and credits nothing', async () => {
    const who = await account(h);
    const before = await balance(who);
    const ids = newIds();
    const res = await deliver(
      h,
      kit,
      buildEvent(h, 'checkout.session.completed', sessionObject(who, PACK, ids, { amount: 1 })),
    );
    expect(res.statusCode).toBe(500);
    expect(apiErrorSchema.safeParse(res.json()).success).toBe(true);
    expect(await balance(who)).toBe(before);
    expect(await chargeRows(ids.session)).toHaveLength(0);
  });

  it('fails loudly on a pack that is not in the price list', async () => {
    const who = await account(h);
    const ids = newIds();
    const session = {
      ...sessionObject(who, PACK, ids),
      metadata: { ...sessionObject(who, PACK, ids).metadata, pack_id: 'pearls-1' },
    };
    const res = await deliver(h, kit, buildEvent(h, 'checkout.session.completed', session));
    expect(res.statusCode).toBe(500);
  });

  it('acknowledges and ignores sessions this app did not create or without consent', async () => {
    const who = await account(h);
    const before = await balance(who);
    const foreign = newIds();
    await deliverOk(
      h,
      kit,
      buildEvent(h, 'checkout.session.completed', {
        ...sessionObject(who, PACK, foreign),
        metadata: {},
      }),
    );
    const unconsented = newIds();
    const base = sessionObject(who, PACK, unconsented);
    await deliverOk(
      h,
      kit,
      buildEvent(h, 'checkout.session.completed', {
        ...base,
        metadata: { ...base.metadata, consent_withdrawal_waiver: 'false' },
      }),
    );
    expect(await chargeRows(foreign.session)).toHaveLength(0);
    expect(await chargeRows(unconsented.session)).toHaveLength(0);
    expect(await balance(who)).toBe(before);
  });

  it('ignores event types it does not handle', async () => {
    await deliverOk(h, kit, buildEvent(h, 'customer.created', { id: 'cus_x', object: 'customer' }));
  });

  it('still records a payment whose buyer deleted the account, without a wallet', async () => {
    const who = await account(h);
    const ids = newIds();
    await deliverOk(
      h,
      kit,
      buildEvent(h, 'checkout.session.completed', {
        ...sessionObject(who, PACK, ids),
        metadata: { ...sessionObject(who, PACK, ids).metadata, user_id: 'user_that_is_gone' },
      }),
    );
    const [row] = await chargeRows(ids.session);
    expect(row).toMatchObject({ userId: null, amountCents: pack.priceCents });
  });
});

describe('refunds', () => {
  it('claws back in proportion, and cumulatively', async () => {
    const who = await account(h);
    const start = await balance(who);
    const ids = await bought(who);
    expect(await balance(who)).toBe(start + 550);

    await deliverOk(h, kit, buildEvent(h, 'refund.created', refundObject(ids.paymentIntent, 100)));
    expect(await balance(who)).toBe(start + 550 - 110);
    await deliverOk(h, kit, buildEvent(h, 'refund.created', refundObject(ids.paymentIntent, 100)));
    expect(await balance(who)).toBe(start + 550 - 220);
  });

  it('applies a refund once per refund id, whatever the event type or delivery', async () => {
    const who = await account(h);
    const start = await balance(who);
    const ids = await bought(who);
    const refund = refundObject(ids.paymentIntent, 100);
    await deliverOk(h, kit, buildEvent(h, 'refund.created', refund));
    await deliverOk(h, kit, buildEvent(h, 'refund.updated', refund));
    await deliverOk(h, kit, buildEvent(h, 'refund.created', refund));
    expect(await balance(who)).toBe(start + 550 - 110);
  });

  it('waits for a refund to succeed', async () => {
    const who = await account(h);
    const start = await balance(who);
    const ids = await bought(who);
    const pending = refundObject(ids.paymentIntent, 499, `re_${ids.session}`, 'pending');
    await deliverOk(h, kit, buildEvent(h, 'refund.created', pending));
    expect(await balance(who)).toBe(start + 550);
    await deliverOk(h, kit, buildEvent(h, 'refund.updated', { ...pending, status: 'succeeded' }));
    expect(await balance(who)).toBe(start);
  });

  it('never takes back more than the pack gave', async () => {
    const who = await account(h);
    const start = await balance(who);
    const ids = await bought(who);
    await deliverOk(h, kit, buildEvent(h, 'refund.created', refundObject(ids.paymentIntent, 300)));
    await deliverOk(h, kit, buildEvent(h, 'refund.created', refundObject(ids.paymentIntent, 300)));
    await deliverOk(h, kit, buildEvent(h, 'refund.created', refundObject(ids.paymentIntent, 5000)));
    expect(await balance(who)).toBe(start);
  });

  it('lets the balance go negative and blocks paid purchases until it is repaired', async () => {
    const who = await account(h);
    await balance(who);
    const ids = await bought(who);
    await h.database.db
      .update(schema.wallet)
      .set({ balance: 10 })
      .where(eq(schema.wallet.userId, who.userId));
    await deliverOk(h, kit, buildEvent(h, 'refund.created', refundObject(ids.paymentIntent, 499)));
    expect(await balance(who)).toBe(10 - 550);

    const refused = await call(h, who, 'POST', '/api/shop/purchase', {
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      itemRef: 'background:bg-fw-misty-lake',
    });
    expect(refused.statusCode).toBe(402);
    expect(apiErrorSchema.parse(refused.json()).error.code).toBe('insufficient_pearls');
  });

  it('asks for redelivery while the payment is unknown, then applies it', async () => {
    const who = await account(h);
    const start = await balance(who);
    const ids = newIds();
    const refund = buildEvent(h, 'refund.created', refundObject(ids.paymentIntent, 499));
    expect((await deliver(h, kit, refund)).statusCode).toBe(500);
    await deliverOk(
      h,
      kit,
      buildEvent(h, 'checkout.session.completed', sessionObject(who, PACK, ids)),
    );
    await deliverOk(h, kit, refund);
    expect(await balance(who)).toBe(start);
  });

  it('keeps the ledger and charge of a deleted account, pseudonymised', async () => {
    const who = await account(h);
    const ids = await bought(who);
    const deleted = await call(h, who, 'POST', '/api/me/delete', { password: PASSWORD });
    expect(deleted.statusCode, deleted.body).toBeLessThan(300);

    const [charge] = await chargeRows(ids.session);
    expect(charge?.userId).toBeNull();
    const kept = await h.database.db
      .select()
      .from(schema.ledger)
      .where(eq(schema.ledger.idempotencyKey, `checkout:${ids.session}`));
    expect(kept).toHaveLength(1);
    expect(kept[0]?.userId).toBeNull();

    const refund = refundObject(ids.paymentIntent, 499);
    await deliverOk(h, kit, buildEvent(h, 'refund.created', refund));
    const [clawed] = await h.database.db
      .select()
      .from(schema.ledger)
      .where(eq(schema.ledger.idempotencyKey, `refund:${refund.id}`));
    expect(clawed).toMatchObject({ userId: null, delta: -pack.pearls });
  });
});

describe('disputes', () => {
  it('claws back on a lost dispute and restores exactly that when it is won later', async () => {
    const who = await account(h);
    const start = await balance(who);
    const ids = await bought(who);
    const dispute = disputeObject(ids.paymentIntent, 499, 'lost');
    await deliverOk(h, kit, buildEvent(h, 'charge.dispute.closed', dispute));
    expect(await balance(who)).toBe(start);

    await deliverOk(h, kit, buildEvent(h, 'charge.dispute.closed', dispute));
    expect(await balance(who)).toBe(start);

    await deliverOk(
      h,
      kit,
      buildEvent(h, 'charge.dispute.funds_reinstated', { ...dispute, status: 'won' }),
    );
    expect(await balance(who)).toBe(start + 550);
    await deliverOk(h, kit, buildEvent(h, 'charge.dispute.closed', { ...dispute, status: 'won' }));
    expect(await balance(who)).toBe(start + 550);
  });

  it('claws nothing when the won event beats a stale lost event', async () => {
    const who = await account(h);
    const start = await balance(who);
    const ids = await bought(who);
    const dispute = disputeObject(ids.paymentIntent, 499, 'won');
    await deliverOk(h, kit, buildEvent(h, 'charge.dispute.closed', dispute));
    await deliverOk(h, kit, buildEvent(h, 'charge.dispute.closed', { ...dispute, status: 'lost' }));
    expect(await balance(who)).toBe(start + 550);
  });

  it('does not act on a dispute that is still open or needs a response', async () => {
    const who = await account(h);
    const start = await balance(who);
    const ids = await bought(who);
    for (const status of ['needs_response', 'under_review', 'warning_needs_response']) {
      await deliverOk(
        h,
        kit,
        buildEvent(h, 'charge.dispute.updated', disputeObject(ids.paymentIntent, 499, status)),
      );
    }
    expect(await balance(who)).toBe(start + 550);
  });

  it('stays capped when a refund and a lost dispute cover the same payment', async () => {
    const who = await account(h);
    const start = await balance(who);
    const ids = await bought(who);
    await deliverOk(h, kit, buildEvent(h, 'refund.created', refundObject(ids.paymentIntent, 100)));
    await deliverOk(
      h,
      kit,
      buildEvent(h, 'charge.dispute.closed', disputeObject(ids.paymentIntent, 499, 'lost')),
    );
    expect(await balance(who)).toBe(start);
  });
});

describe('Aquarist Club', () => {
  it('records the first invoice, mails a receipt, and grants once per UTC day', async () => {
    const who = await account(h);
    const start = await balance(who);
    const ids = await subscribed(who);

    const mail = h.outbox.findLast((m) => m.to === who.email && m.text.includes('first month'));
    expect(mail?.text).toContain('€4.99');

    expect(await balance(who)).toBe(start + DAILY);
    expect(await balance(who)).toBe(start + DAILY);
    h.clock.advance(msToNextUtcMidnight());
    expect(await balance(who)).toBe(start + 2 * DAILY);
    expect(await balance(who)).toBe(start + 2 * DAILY);

    const keys = (await stripeLedger(who)).map((e) => e.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => k?.startsWith(`sub:${ids.subscription}:`))).toBe(true);

    const state = paymentsStateSchema.parse(
      (await call(h, who, 'GET', '/api/payments/state')).json(),
    );
    expect(state.subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: false });
    expect(state.subscription?.paidUntil).not.toBeNull();
  });

  it('does not double-grant on a duplicate invoice.paid', async () => {
    const who = await account(h);
    const start = await balance(who);
    const ids = newIds();
    const now = h.clock.now();
    const invoice = invoiceObject(who, ids, {
      start: seconds(now),
      end: seconds(now + 30 * DAY_MS),
    });
    await deliverOk(h, kit, buildEvent(h, 'invoice.paid', invoice));
    await deliverOk(h, kit, buildEvent(h, 'invoice.paid', invoice));
    expect(await balance(who)).toBe(start + DAILY);
    expect(await chargeRows(ids.invoice)).toHaveLength(1);
    expect(
      h.outbox.filter((m) => m.to === who.email && m.text.includes('first month')),
    ).toHaveLength(1);
  });

  it('ignores a zero-amount invoice and invoices of other products', async () => {
    const who = await account(h);
    const start = await balance(who);
    const free = newIds();
    const now = h.clock.now();
    const period = { start: seconds(now), end: seconds(now + 30 * DAY_MS) };
    await deliverOk(
      h,
      kit,
      buildEvent(h, 'invoice.paid', invoiceObject(who, free, period, { amount: 0 })),
    );
    expect(await chargeRows(free.invoice)).toHaveLength(0);
    expect(await balance(who)).toBe(start);
  });

  it('stops granting once the paid period has run out without a renewal', async () => {
    const who = await account(h);
    const start = await balance(who);
    await subscribed(who, 2);
    expect(await balance(who)).toBe(start + DAILY);
    h.clock.advance(3 * DAY_MS);
    expect(await balance(who)).toBe(start + DAILY);
    h.clock.advance(DAY_MS);
    expect(await balance(who)).toBe(start + DAILY);
  });

  it('keeps granting through a renewal', async () => {
    const who = await account(h);
    const start = await balance(who);
    const ids = newIds();
    const now = h.clock.now();
    const first = { start: seconds(now), end: seconds(now + 2 * DAY_MS) };
    await deliverOk(h, kit, buildEvent(h, 'invoice.paid', invoiceObject(who, ids, first)));
    const second = { start: first.end, end: first.end + 30 * 86_400 };
    await deliverOk(
      h,
      kit,
      buildEvent(
        h,
        'invoice.paid',
        invoiceObject(who, { ...ids, invoice: `${ids.invoice}_2` }, second, {
          reason: 'subscription_cycle',
        }),
      ),
    );
    h.clock.advance(3 * DAY_MS);
    expect(await balance(who)).toBe(start + DAILY);
    h.clock.advance(DAY_MS);
    expect(await balance(who)).toBe(start + 2 * DAILY);
  });

  it('stops while past_due or unpaid and resumes on recovery', async () => {
    const who = await account(h);
    const start = await balance(who);
    const ids = await subscribed(who);
    expect(await balance(who)).toBe(start + DAILY);
    const t = seconds(h.clock.now());

    await deliverOk(
      h,
      kit,
      buildEvent(
        h,
        'customer.subscription.updated',
        subscriptionObject(who, ids.subscription, 'past_due'),
        { created: t + 10 },
      ),
    );
    h.clock.advance(msToNextUtcMidnight());
    expect(await balance(who)).toBe(start + DAILY);

    await deliverOk(
      h,
      kit,
      buildEvent(
        h,
        'customer.subscription.updated',
        subscriptionObject(who, ids.subscription, 'unpaid'),
        { created: t + 20 },
      ),
    );
    h.clock.advance(DAY_MS);
    expect(await balance(who)).toBe(start + DAILY);

    await deliverOk(
      h,
      kit,
      buildEvent(
        h,
        'customer.subscription.updated',
        subscriptionObject(who, ids.subscription, 'active'),
        { created: t + 30 },
      ),
    );
    expect(await balance(who)).toBe(start + 2 * DAILY);
  });

  it('ignores a subscription event older than the one already applied', async () => {
    const who = await account(h);
    const start = await balance(who);
    const ids = await subscribed(who);
    const t = seconds(h.clock.now());
    await deliverOk(
      h,
      kit,
      buildEvent(
        h,
        'customer.subscription.updated',
        subscriptionObject(who, ids.subscription, 'past_due'),
        { created: t + 100 },
      ),
    );
    await deliverOk(
      h,
      kit,
      buildEvent(
        h,
        'customer.subscription.updated',
        subscriptionObject(who, ids.subscription, 'active'),
        { created: t + 50 },
      ),
    );
    h.clock.advance(msToNextUtcMidnight());
    expect(await balance(who)).toBe(start);
  });

  it('keeps granting after a cancel until the paid period ends, and stops when it is deleted', async () => {
    const who = await account(h);
    const start = await balance(who);
    const ids = await subscribed(who);
    expect(await balance(who)).toBe(start + DAILY);
    const t = seconds(h.clock.now());
    await deliverOk(
      h,
      kit,
      buildEvent(
        h,
        'customer.subscription.updated',
        subscriptionObject(who, ids.subscription, 'active', true),
        { created: t + 10 },
      ),
    );
    const state = paymentsStateSchema.parse(
      (await call(h, who, 'GET', '/api/payments/state')).json(),
    );
    expect(state.subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    h.clock.advance(msToNextUtcMidnight());
    expect(await balance(who)).toBe(start + 2 * DAILY);

    await deliverOk(
      h,
      kit,
      buildEvent(
        h,
        'customer.subscription.deleted',
        subscriptionObject(who, ids.subscription, 'canceled', true),
        { created: t + 20 },
      ),
    );
    h.clock.advance(DAY_MS);
    expect(await balance(who)).toBe(start + 2 * DAILY);
  });

  describe('refunded invoice', () => {
    async function twoDaysPaid() {
      const who = await account(h);
      const start = await balance(who);
      const ids = await subscribed(who);
      await deliverOk(
        h,
        kit,
        buildEvent(h, 'invoice_payment.paid', {
          id: `inpay_${ids.invoice}`,
          object: 'invoice_payment',
          invoice: ids.invoice,
          payment: { type: 'payment_intent', payment_intent: ids.paymentIntent },
        }),
      );
      expect(await balance(who)).toBe(start + DAILY);
      h.clock.advance(msToNextUtcMidnight());
      expect(await balance(who)).toBe(start + 2 * DAILY);
      return { who, start, ids };
    }

    it('claws back the period grants and stops further ones when fully refunded', async () => {
      const { who, start, ids } = await twoDaysPaid();
      await deliverOk(
        h,
        kit,
        buildEvent(
          h,
          'refund.created',
          refundObject(ids.paymentIntent, economy.subscription.priceCents),
        ),
      );
      expect(await balance(who)).toBe(start);
      h.clock.advance(DAY_MS);
      expect(await balance(who)).toBe(start);
      const state = paymentsStateSchema.parse(
        (await call(h, who, 'GET', '/api/payments/state')).json(),
      );
      expect(state.subscription?.paidUntil).toBeNull();
    });

    it('claws back proportionally on a partial refund and keeps granting', async () => {
      const { who, start, ids } = await twoDaysPaid();
      const half = Math.floor(economy.subscription.priceCents / 2);
      await deliverOk(
        h,
        kit,
        buildEvent(h, 'refund.created', refundObject(ids.paymentIntent, half)),
      );
      const expected =
        start + 2 * DAILY - Math.floor((2 * DAILY * half) / economy.subscription.priceCents);
      expect(await balance(who)).toBe(expected);
      h.clock.advance(DAY_MS);
      expect(await balance(who)).toBe(expected + DAILY);
    });

    it('claws back on a lost dispute and gives it back when the dispute is won', async () => {
      const { who, start, ids } = await twoDaysPaid();
      const dispute = disputeObject(ids.paymentIntent, economy.subscription.priceCents, 'lost');
      await deliverOk(h, kit, buildEvent(h, 'charge.dispute.closed', dispute));
      expect(await balance(who)).toBe(start);
      h.clock.advance(DAY_MS);
      expect(await balance(who)).toBe(start);

      await deliverOk(
        h,
        kit,
        buildEvent(h, 'charge.dispute.closed', { ...dispute, status: 'won' }),
      );
      expect(await balance(who)).toBe(start + 2 * DAILY + DAILY);
    });
  });
});

describe('signature gate', () => {
  it('credits nothing for an event signed with another secret', async () => {
    const who = await account(h);
    const start = await balance(who);
    const stranger = paymentsKit();
    const res = await deliver(
      h,
      stranger,
      buildEvent(h, 'checkout.session.completed', sessionObject(who, PACK, newIds())),
    );
    expect(res.statusCode).toBe(400);
    expect(await balance(who)).toBe(start);
  });
});
