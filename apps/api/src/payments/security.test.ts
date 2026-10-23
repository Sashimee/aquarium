import {
  apiErrorSchema,
  dataExportSchema,
  paymentsStateSchema,
  PRIVACY_POLICY,
} from '@aquarium/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/index.ts';
import { MailThrottledError, SMTP_TIMEOUT_MS } from '../mail.ts';
import { createHarness, type Harness } from '../test-harness.ts';
import { RECEIPT_LEASE_MS } from './routes.ts';
import {
  DAY_MS,
  PASSWORD,
  account,
  buildEvent,
  call,
  deliver,
  deliverOk,
  invoiceObject,
  newIds,
  paymentsKit,
  refundObject,
  seconds,
  sessionObject,
  sign,
  subscriptionObject,
  type Account,
  type PaymentsKit,
} from './testkit.ts';

const lines: string[] = [];
let h: Harness;
let kit: PaymentsKit;

beforeAll(async () => {
  kit = paymentsKit();
  h = await createHarness({
    payments: kit.provider,
    logStream: { write: (chunk) => void lines.push(chunk) },
  });
});
afterAll(() => h.close());

const confirm = (who: Account, body: object) =>
  call(h, who, 'PUT', '/api/payments/adult-confirmation', body);

const packMails = (who: Account) =>
  h.outbox.filter((m) => m.to === who.email && m.text.includes('Pearls added'));

const subscriptionMails = (who: Account) =>
  h.outbox.filter((m) => m.to === who.email && m.text.includes('subscription'));

const chargeOf = async (id: string) => {
  const [row] = await h.database.db
    .select()
    .from(schema.paymentCharges)
    .where(eq(schema.paymentCharges.id, id));
  return row;
};

const buy = async (who: Account) => {
  const ids = newIds();
  await deliverOk(
    h,
    kit,
    buildEvent(h, 'checkout.session.completed', sessionObject(who, 'pearls-550', ids)),
  );
  return ids;
};

const subscribe = async (who: Account) => {
  const ids = newIds();
  const start = seconds(h.clock.now());
  await deliverOk(
    h,
    kit,
    buildEvent(
      h,
      'invoice.paid',
      invoiceObject(who, ids, { start, end: start + 30 * (DAY_MS / 1000) }),
    ),
  );
  return ids;
};

async function withFailingReceipts<T>(error: Error, work: () => Promise<T>): Promise<T> {
  const original = h.mailer.sendReceipt;
  h.mailer.sendReceipt = () => Promise.reject(error);
  try {
    return await work();
  } finally {
    h.mailer.sendReceipt = original;
  }
}

describe('adult confirmation', () => {
  it('needs the current password', async () => {
    const who = await account(h);
    for (const body of [
      { confirmed: true },
      { confirmed: true, password: 'not the password at all' },
    ]) {
      const res = await confirm(who, body);
      expect(res.statusCode).toBe(403);
      expect(apiErrorSchema.parse(res.json()).error.code).toBe('forbidden');
    }
    const state = await call(h, who, 'GET', '/api/payments/state');
    expect(paymentsStateSchema.parse(state.json()).adultConfirmed).toBe(false);

    const ok = await confirm(who, { confirmed: true, password: PASSWORD });
    expect(paymentsStateSchema.parse(ok.json()).adultConfirmed).toBe(true);
  });

  it('withdraws without a password', async () => {
    const who = await account(h);
    await confirm(who, { confirmed: true, password: PASSWORD });
    const off = await confirm(who, { confirmed: false });
    expect(paymentsStateSchema.parse(off.json()).adultConfirmed).toBe(false);
  });

  it('keeps a withdrawal timestamp instead of deleting the record, and clears it on re-confirming', async () => {
    const who = await account(h);
    const row = async () =>
      (
        await h.database.db
          .select()
          .from(schema.adultConfirmations)
          .where(
            and(
              eq(schema.adultConfirmations.userId, who.userId),
              isNull(schema.adultConfirmations.withdrawnAt),
            ),
          )
      )[0];
    await confirm(who, { confirmed: true, password: PASSWORD });
    expect(await row()).toBeDefined();
    await confirm(who, { confirmed: false });
    expect(await row()).toBeUndefined();
    const state = await call(h, who, 'GET', '/api/payments/state');
    expect(paymentsStateSchema.parse(state.json()).adultConfirmed).toBe(false);
    await confirm(who, { confirmed: true, password: PASSWORD });
    expect(await row()).toBeDefined();
    expect(
      paymentsStateSchema.parse((await call(h, who, 'GET', '/api/payments/state')).json())
        .adultConfirmed,
    ).toBe(true);
  });

  it('shares one guess budget with account deletion', async () => {
    const who = await account(h);
    for (let i = 0; i < 3; i++) await confirm(who, { confirmed: true, password: 'wrong guess' });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push(
        (await call(h, who, 'POST', '/api/me/delete', { password: 'wrong guess' })).statusCode,
      );
    }
    expect(codes).toEqual([403, 403, 429]);
  });

  it('throttles wrong guesses', async () => {
    const who = await account(h);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await confirm(who, { confirmed: true, password: 'wrong guess' })).statusCode);
    }
    expect(codes).toEqual([403, 403, 403, 403, 403, 429]);
  });
});

describe('receipts', () => {
  it('are not capped per recipient, so every paid checkout gets one', async () => {
    const who = await account(h);
    for (let i = 0; i < 7; i++) await buy(who);
    expect(packMails(who)).toHaveLength(7);
  });

  it('stay queued when the mail throttle refuses one', async () => {
    const who = await account(h);
    const ids = await withFailingReceipts(new MailThrottledError(60), () => buy(who));
    expect((await chargeOf(ids.session))?.receiptPending).toBe(true);
    expect(packMails(who)).toHaveLength(0);
  });

  it('stay queued when the transport fails, and go out on the next webhook', async () => {
    const who = await account(h);
    const ids = await withFailingReceipts(new Error('relay refused the connection'), () =>
      buy(who),
    );
    expect((await chargeOf(ids.session))?.receiptPending).toBe(true);
    expect(packMails(who)).toHaveLength(0);

    h.clock.advance(6 * 60_000);
    await buy(await account(h));
    expect(packMails(who)).toHaveLength(1);
    expect(packMails(who)[0]?.text).toContain('immediate delivery');
    expect((await chargeOf(ids.session))?.receiptPending).toBe(false);
  });

  it('are retried by the periodic job, subscriptions included, once each', async () => {
    const who = await account(h);
    const ids = await withFailingReceipts(new Error('relay down'), () => subscribe(who));
    expect((await chargeOf(ids.invoice))?.receiptPending).toBe(true);

    h.clock.advance(6 * 60_000);
    expect(await h.app.retryPendingReceipts()).toBeGreaterThanOrEqual(1);
    expect(subscriptionMails(who)).toHaveLength(1);
    await h.app.retryPendingReceipts();
    expect(subscriptionMails(who)).toHaveLength(1);
    expect((await chargeOf(ids.invoice))?.receiptPending).toBe(false);
  });
});

describe('receipt delivery', () => {
  it('logs only the error class, never the address an SMTP reply names', async () => {
    const who = await account(h);
    const rejection = Object.assign(
      new Error(`Recipient command failed: 550 5.1.1 <${who.email}>: Recipient address rejected`),
      { code: 'EENVELOPE' },
    );
    lines.length = 0;
    await withFailingReceipts(rejection, () => buy(who));
    const logged = lines.join('');
    expect(logged).toContain('receipt mail not sent');
    expect(logged).toContain('EENVELOPE');
    expect(logged).not.toContain(who.email);
    expect(logged).not.toContain('Recipient address rejected');
  });

  it('sends one mail when several webhooks and the periodic job race for the same receipt', async () => {
    const who = await account(h);
    const ids = await withFailingReceipts(new Error('relay down'), () => buy(who));
    h.clock.advance(6 * 60_000);

    const original = h.mailer.sendReceipt;
    h.mailer.sendReceipt = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return original(...args);
    };
    try {
      await Promise.all([
        h.app.retryPendingReceipts(),
        h.app.retryPendingReceipts(),
        h.app.retryPendingReceipts(),
        buy(await account(h)),
      ]);
    } finally {
      h.mailer.sendReceipt = original;
    }
    expect(packMails(who)).toHaveLength(1);
    expect((await chargeOf(ids.session))?.receiptPending).toBe(false);
  });

  it('answers the webhook before the mail is sent', async () => {
    const who = await account(h);
    const ids = newIds();
    const original = h.mailer.sendReceipt;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.mailer.sendReceipt = async (...args) => {
      await gate;
      return original(...args);
    };
    try {
      const payload = JSON.stringify(
        buildEvent(h, 'checkout.session.completed', sessionObject(who, 'pearls-550', ids)),
      );
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/payments/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': sign(kit, payload) },
        payload,
      });
      expect(res.statusCode).toBe(200);
      expect(packMails(who)).toHaveLength(0);
      release();
      await h.app.receiptsIdle();
    } finally {
      release();
      h.mailer.sendReceipt = original;
    }
    expect(packMails(who)).toHaveLength(1);
  });

  it('backs off after a failure and stops after the attempt cap', async () => {
    const who = await account(h);
    const ids = await withFailingReceipts(new Error('relay down'), () => buy(who));
    expect((await chargeOf(ids.session))?.receiptAttempts).toBe(1);

    await h.app.retryPendingReceipts();
    expect((await chargeOf(ids.session))?.receiptAttempts).toBe(1);

    await withFailingReceipts(new Error('relay down'), async () => {
      for (let i = 0; i < 12; i++) {
        h.clock.advance(7 * 3_600_000);
        await h.app.retryPendingReceipts();
      }
    });
    const row = await chargeOf(ids.session);
    expect(row?.receiptAttempts).toBe(8);

    h.clock.advance(7 * 3_600_000);
    await h.app.retryPendingReceipts();
    expect(packMails(who)).toHaveLength(0);
  });

  it('does not let abandoned receipts hide newer ones', async () => {
    const dead = await account(h);
    const deadIds = await withFailingReceipts(new Error('permanent'), () => buy(dead));
    await h.database.db
      .update(schema.paymentCharges)
      .set({ receiptAttempts: 8 })
      .where(eq(schema.paymentCharges.id, deadIds.session));
    const fresh = await account(h);
    const freshIds = await withFailingReceipts(new Error('relay down'), () => buy(fresh));
    h.clock.advance(6 * 60_000);
    await h.app.retryPendingReceipts();
    expect(packMails(fresh)).toHaveLength(1);
    expect((await chargeOf(freshIds.session))?.receiptPending).toBe(false);
    expect(packMails(dead)).toHaveLength(0);
  });
});

describe('settlement failure log', () => {
  it('carries no bound parameters', async () => {
    const who = await account(h);
    const ids = newIds();
    const huge = 3_000_000_000;
    const session = sessionObject(who, 'pearls-550', ids, { amount: huge, promisedCents: huge });
    lines.length = 0;
    const res = await deliver(h, kit, buildEvent(h, 'checkout.session.completed', session));
    expect(res.statusCode).toBe(500);
    const logged = lines.join('');
    expect(logged).toContain('payment event could not be settled');
    expect(logged).not.toContain(who.userId);
    expect(logged).not.toContain(who.email);
    expect(logged).not.toContain(ids.session);
    expect(logged).not.toMatch(/params:/);
  });
});

describe('data export', () => {
  it('keeps every adult confirm and withdraw cycle, oldest first', async () => {
    const who = await account(h);
    const exported = async () =>
      dataExportSchema.parse((await call(h, who, 'POST', '/api/me/export')).json()).payments
        .adultConfirmations;
    await confirm(who, { confirmed: true, password: PASSWORD });
    const [open] = await exported();
    expect(open?.withdrawnAt).toBeNull();

    await confirm(who, { confirmed: false });
    await confirm(who, { confirmed: true, password: PASSWORD });
    await confirm(who, { confirmed: true, password: PASSWORD });
    const cycles = await exported();
    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toEqual({ confirmedAt: open?.confirmedAt, withdrawnAt: expect.any(String) });
    expect(cycles[1]?.withdrawnAt).toBeNull();
    expect(Date.parse(cycles[1]?.confirmedAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(cycles[0]?.withdrawnAt ?? ''),
    );
  });

  it('bounds a stalled mail send well inside the receipt lease', () => {
    expect(SMTP_TIMEOUT_MS * 3).toBeLessThan(RECEIPT_LEASE_MS);
  });

  it('lists the charges with consent times, refunds, subscription and adult confirmation', async () => {
    const who = await account(h);
    await confirm(who, { confirmed: true, password: PASSWORD });
    const pack = await buy(who);
    await deliverOk(h, kit, buildEvent(h, 'refund.created', refundObject(pack.paymentIntent, 100)));
    const sub = await subscribe(who);
    await deliverOk(
      h,
      kit,
      buildEvent(
        h,
        'customer.subscription.updated',
        subscriptionObject(who, sub.subscription, 'active'),
      ),
    );

    const res = await call(h, who, 'POST', '/api/me/export');
    expect(res.statusCode, res.body).toBe(200);
    const { payments } = dataExportSchema.parse(res.json());
    expect(payments.adultConfirmations).toHaveLength(1);
    expect(payments.charges.map((c) => c['id'])).toEqual(
      expect.arrayContaining([pack.session, sub.invoice]),
    );
    const packCharge = payments.charges.find((c) => c['id'] === pack.session);
    expect(packCharge?.['consentAt']).toEqual(expect.any(String));
    expect(packCharge).not.toHaveProperty('receiptPending');
    expect(payments.refunds).toHaveLength(1);
    expect(payments.clubSubscriptions.map((s) => s['id'])).toEqual([sub.subscription]);
  });

  it("does not include someone else's payments", async () => {
    const mine = await account(h);
    const bought = await buy(await account(h));
    const res = await call(h, mine, 'POST', '/api/me/export');
    expect(dataExportSchema.parse(res.json()).payments.charges).toEqual([]);
    expect(res.body).not.toContain(bought.session);
  });
});

describe('privacy policy', () => {
  const text = JSON.stringify(PRIVACY_POLICY);

  it('names Stripe as a processor and says what is sent', () => {
    expect(PRIVACY_POLICY.sections.map((s) => s.id)).toContain('processors');
    expect(text).toContain('Stripe Payments Europe');
    expect(text).toContain('account email address');
    expect(text).toContain('adult confirmed purchases');
  });

  it('no longer speaks of packs as upcoming', () => {
    expect(text).not.toContain('once Pearl packs are on sale');
  });
});
