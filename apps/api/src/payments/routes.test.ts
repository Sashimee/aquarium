import {
  apiErrorSchema,
  checkoutResponseSchema,
  healthResponseSchema,
  packsResponseSchema,
  paymentsStateSchema,
  walletResponseSchema,
} from '@aquarium/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/index.ts';
import { createHarness, type Harness } from '../test-harness.ts';
import {
  account,
  buildEvent,
  call,
  deliver,
  deliverOk,
  economy,
  jsonHeaders,
  newIds,
  paymentsKit,
  sessionObject,
  invoiceObject,
  subscriptionObject,
  seconds,
  sign,
  DAY_MS,
  PASSWORD,
  type PaymentsKit,
} from './testkit.ts';
import type { PaymentProvider } from './provider.ts';

const CONSENT = { immediateDelivery: true, withdrawalWaiver: true };

describe('payments disabled', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('reports it on health', async () => {
    const res = await h.app.inject('/api/health');
    expect(healthResponseSchema.parse(res.json())).toEqual({ status: 'ok', payments: 'disabled' });
  });

  it('answers 503 on every route that needs Stripe, and the rest works', async () => {
    const who = await account(h);
    for (const [method, url, payload] of [
      ['GET', '/api/payments/packs', undefined],
      ['POST', '/api/payments/checkout/pack', { packId: 'pearls-550', consent: CONSENT }],
      ['POST', '/api/payments/checkout/subscription', { consent: CONSENT }],
      ['POST', '/api/payments/subscription/cancel', undefined],
    ] as const) {
      const res = await call(h, who, method, url, payload);
      expect(res.statusCode, url).toBe(503);
      const body = apiErrorSchema.parse(res.json());
      expect(body.error.code).toBe('payments_disabled');
      expect(body.error.message).toMatch(/not available/);
    }
    const webhook = await h.app.inject({
      method: 'POST',
      url: '/api/payments/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' },
      payload: '{}',
    });
    expect(webhook.statusCode).toBe(503);

    const state = paymentsStateSchema.parse(
      (await call(h, who, 'GET', '/api/payments/state')).json(),
    );
    expect(state).toEqual({ payments: 'disabled', adultConfirmed: false, subscription: null });
    const wallet = await call(h, who, 'GET', '/api/wallet');
    expect(walletResponseSchema.parse(wallet.json()).wallet.balance).toBe(economy.grants.starting);
  });

  it('keeps the adult confirmation settable while payments are off', async () => {
    const who = await account(h);
    const on = await call(h, who, 'PUT', '/api/payments/adult-confirmation', {
      confirmed: true,
      password: PASSWORD,
    });
    expect(paymentsStateSchema.parse(on.json()).adultConfirmed).toBe(true);
    const off = await call(h, who, 'PUT', '/api/payments/adult-confirmation', { confirmed: false });
    expect(paymentsStateSchema.parse(off.json()).adultConfirmed).toBe(false);
  });

  it('needs a session for the state', async () => {
    expect((await h.app.inject('/api/payments/state')).statusCode).toBe(401);
  });
});

describe('payments enabled', () => {
  let h: Harness;
  let kit: PaymentsKit;
  const calls: string[] = [];
  let failCancel = false;
  let badUrl = false;

  beforeAll(async () => {
    kit = paymentsKit((real): PaymentProvider => ({
      ...real,
      createPackCheckout: (input) => {
        calls.push(`pack:${input.packId}:${input.priceCents}`);
        if (badUrl) return Promise.resolve({ url: 'http://pay.example/insecure' });
        return real.createPackCheckout(input);
      },
      cancelSubscriptionAtPeriodEnd: (id) => {
        calls.push(`cancel:${id}`);
        return real.cancelSubscriptionAtPeriodEnd(id);
      },
      cancelSubscriptionNow: async (id) => {
        calls.push(`cancel-now:${id}`);
        if (failCancel) throw new Error('provider down');
        return real.cancelSubscriptionNow(id);
      },
    }));
    h = await createHarness({ payments: kit.provider });
  });
  afterAll(() => h.close());

  it('reports it on health', async () => {
    const res = await h.app.inject('/api/health');
    expect(healthResponseSchema.parse(res.json()).payments).toBe('enabled');
  });

  it('lists only the packs sold on the web', async () => {
    const who = await account(h);
    const res = await call(h, who, 'GET', '/api/payments/packs');
    const body = packsResponseSchema.parse(res.json());
    expect(body.packs.map((p) => p.id)).not.toContain('pearls-100');
    expect(body.packs.map((p) => p.id)).toContain('pearls-550');
    expect(body.subscription.priceCents).toBe(499);
  });

  it('refuses to start a purchase before an adult confirmed it', async () => {
    const who = await account(h);
    const res = await call(h, who, 'POST', '/api/payments/checkout/pack', {
      packId: 'pearls-550',
      consent: CONSENT,
    });
    expect(res.statusCode).toBe(403);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('adult_confirmation_required');
    const sub = await call(h, who, 'POST', '/api/payments/checkout/subscription', {
      consent: CONSENT,
    });
    expect(sub.statusCode).toBe(403);
  });

  it('creates a Checkout Session at the server price once confirmed', async () => {
    const who = await account(h);
    await call(h, who, 'PUT', '/api/payments/adult-confirmation', {
      confirmed: true,
      password: PASSWORD,
    });
    const res = await call(h, who, 'POST', '/api/payments/checkout/pack', {
      packId: 'pearls-1200',
      consent: CONSENT,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(checkoutResponseSchema.parse(res.json()).url).toMatch(/^https:\/\//);
    expect(calls).toContain('pack:pearls-1200:999');
  });

  it('needs both consents and never takes an amount from the client', async () => {
    const who = await account(h);
    await call(h, who, 'PUT', '/api/payments/adult-confirmation', {
      confirmed: true,
      password: PASSWORD,
    });
    for (const consent of [
      { immediateDelivery: true, withdrawalWaiver: false },
      { immediateDelivery: false, withdrawalWaiver: true },
      {},
    ]) {
      const res = await call(h, who, 'POST', '/api/payments/checkout/pack', {
        packId: 'pearls-550',
        consent,
      });
      expect(res.statusCode).toBe(400);
    }
    const priced = await call(h, who, 'POST', '/api/payments/checkout/pack', {
      packId: 'pearls-550',
      consent: CONSENT,
      priceCents: 1,
    });
    expect(priced.statusCode).toBe(400);
  });

  it('refuses a pack that is not sold on the web or does not exist', async () => {
    const who = await account(h);
    await call(h, who, 'PUT', '/api/payments/adult-confirmation', {
      confirmed: true,
      password: PASSWORD,
    });
    for (const packId of ['pearls-100', 'pearls-999999']) {
      const res = await call(h, who, 'POST', '/api/payments/checkout/pack', {
        packId,
        consent: CONSENT,
      });
      expect(res.statusCode, packId).toBe(400);
    }
  });

  it('starts a subscription checkout, and not a second one while one runs', async () => {
    const who = await account(h);
    await call(h, who, 'PUT', '/api/payments/adult-confirmation', {
      confirmed: true,
      password: PASSWORD,
    });
    const first = await call(h, who, 'POST', '/api/payments/checkout/subscription', {
      consent: CONSENT,
    });
    expect(first.statusCode, first.body).toBe(200);

    const ids = newIds();
    const now = h.clock.now();
    await deliverOk(
      h,
      kit,
      buildEvent(
        h,
        'invoice.paid',
        invoiceObject(who, ids, {
          start: seconds(now),
          end: seconds(now + 30 * DAY_MS),
        }),
      ),
    );
    const again = await call(h, who, 'POST', '/api/payments/checkout/subscription', {
      consent: CONSENT,
    });
    expect(again.statusCode).toBe(409);
  });

  it('cancels in one step and keeps the paid period', async () => {
    const who = await account(h);
    const none = await call(h, who, 'POST', '/api/payments/subscription/cancel');
    expect(none.statusCode).toBe(409);

    const ids = newIds();
    const now = h.clock.now();
    await deliverOk(
      h,
      kit,
      buildEvent(
        h,
        'invoice.paid',
        invoiceObject(who, ids, {
          start: seconds(now),
          end: seconds(now + 30 * DAY_MS),
        }),
      ),
    );
    const res = await call(h, who, 'POST', '/api/payments/subscription/cancel');
    expect(res.statusCode, res.body).toBe(200);
    const state = paymentsStateSchema.parse(res.json());
    expect(state.subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    expect(state.subscription?.paidUntil).not.toBeNull();
    expect(calls).toContain(`cancel:${ids.subscription}`);

    const repeat = await call(h, who, 'POST', '/api/payments/subscription/cancel');
    expect(repeat.statusCode).toBe(200);
    expect(calls.filter((c) => c === `cancel:${ids.subscription}`)).toHaveLength(1);
  });

  it('rejects unsigned, mis-signed and tampered webhook calls', async () => {
    const who = await account(h);
    const event = buildEvent(
      h,
      'checkout.session.completed',
      sessionObject(who, 'pearls-550', newIds()),
    );
    const payload = JSON.stringify(event);
    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/payments/webhook',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(missing.statusCode).toBe(400);

    const other = paymentsKit();
    const wrongKey = await deliver(h, other, event);
    expect(wrongKey.statusCode).toBe(400);

    const signature = sign(kit, payload);
    const tampered = await h.app.inject({
      method: 'POST',
      url: '/api/payments/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      payload: payload.replace('pearls-550', 'pearls-14000'),
    });
    expect(tampered.statusCode).toBe(400);
  });

  it('cancels a running subscription before deleting the account, and stops if that fails', async () => {
    const who = await account(h);
    const ids = newIds();
    const now = h.clock.now();
    await deliverOk(
      h,
      kit,
      buildEvent(
        h,
        'invoice.paid',
        invoiceObject(who, ids, {
          start: seconds(now),
          end: seconds(now + 30 * DAY_MS),
        }),
      ),
    );

    const withPassword = (payload: object) =>
      h.app.inject({
        method: 'POST',
        url: '/api/me/delete',
        headers: { ...jsonHeaders, cookie: who.cookie },
        payload,
      });
    failCancel = true;
    const blocked = await withPassword({ password: 'correct horse battery' });
    failCancel = false;
    expect(blocked.statusCode).toBe(502);
    const [stillThere] = await h.database.db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, who.userId));
    expect(stillThere).toBeDefined();

    const done = await withPassword({ password: 'correct horse battery' });
    expect(done.statusCode, done.body).toBeLessThan(300);
    expect(calls).toContain(`cancel-now:${ids.subscription}`);
  });

  it('keeps showing, cancelling and guarding the paid subscription after a twin', async () => {
    const who = await account(h);
    const first = newIds();
    const twin = newIds();
    const now = h.clock.now();
    for (const ids of [first, twin]) {
      await deliverOk(
        h,
        kit,
        buildEvent(
          h,
          'invoice.paid',
          invoiceObject(who, ids, { start: seconds(now), end: seconds(now + 30 * DAY_MS) }),
        ),
      );
    }
    kit.subscriptions.set(twin.subscription, { status: 'canceled', cancelAtPeriodEnd: false });
    await deliverOk(
      h,
      kit,
      buildEvent(
        h,
        'customer.subscription.deleted',
        subscriptionObject(who, twin.subscription, 'canceled'),
      ),
    );

    const state = paymentsStateSchema.parse(
      (await call(h, who, 'GET', '/api/payments/state')).json(),
    );
    expect(state.subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: false });
    expect(state.subscription?.paidUntil).not.toBeNull();

    const again = await call(h, who, 'POST', '/api/payments/checkout/subscription', {
      consent: CONSENT,
    });
    expect(again.statusCode).toBe(403);
    await call(h, who, 'PUT', '/api/payments/adult-confirmation', {
      confirmed: true,
      password: PASSWORD,
    });
    const blocked = await call(h, who, 'POST', '/api/payments/checkout/subscription', {
      consent: CONSENT,
    });
    expect(blocked.statusCode, blocked.body).toBe(409);

    const cancelled = await call(h, who, 'POST', '/api/payments/subscription/cancel');
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(paymentsStateSchema.parse(cancelled.json()).subscription?.cancelAtPeriodEnd).toBe(true);
    expect(calls).toContain(`cancel:${first.subscription}`);
    expect(calls).not.toContain(`cancel:${twin.subscription}`);
  });

  it('refunds against stripe-mock with the request shape Stripe validates', async () => {
    await expect(kit.real.refundInvoice('in_mock')).resolves.toBeUndefined();
  });

  it('answers 502 when the provider hands back a URL that is not https', async () => {
    const who = await account(h);
    await call(h, who, 'PUT', '/api/payments/adult-confirmation', {
      confirmed: true,
      password: PASSWORD,
    });
    badUrl = true;
    const res = await call(h, who, 'POST', '/api/payments/checkout/pack', {
      packId: 'pearls-1200',
      consent: CONSENT,
    });
    badUrl = false;
    expect(res.statusCode, res.body).toBe(502);
    expect(res.body).not.toContain('pay.example');
  });

  it('cancels an incomplete subscription too when the account is deleted', async () => {
    const who = await account(h);
    const ids = newIds();
    await h.database.db.insert(schema.clubSubscriptions).values({
      id: ids.subscription,
      userId: who.userId,
      status: 'incomplete',
      statusEventAt: new Date(h.clock.now()),
    });
    const done = await call(h, who, 'POST', '/api/me/delete', { password: PASSWORD });
    expect(done.statusCode, done.body).toBeLessThan(300);
    expect(calls).toContain(`cancel-now:${ids.subscription}`);
  });

  it('refuses a request from another origin on every payment mutation', async () => {
    const who = await account(h);
    for (const [method, url, payload] of [
      ['PUT', '/api/payments/adult-confirmation', { confirmed: true, password: PASSWORD }],
      ['POST', '/api/payments/checkout/pack', { packId: 'pearls-1200', consent: CONSENT }],
      ['POST', '/api/payments/checkout/subscription', { consent: CONSENT }],
      ['POST', '/api/payments/subscription/cancel', undefined],
    ] as const) {
      const res = await h.app.inject({
        method,
        url,
        headers: { ...jsonHeaders, origin: 'https://evil.example', cookie: who.cookie },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode, url).toBe(403);
    }
    const state = paymentsStateSchema.parse(
      (await call(h, who, 'GET', '/api/payments/state')).json(),
    );
    expect(state.adultConfirmed).toBe(false);
  });
});

describe('payments rate limits', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({
      payments: paymentsKit().provider,
      paymentsLimits: {
        checkout: { max: 2, windowMs: 60_000 },
        cancel: { max: 2, windowMs: 60_000 },
        settings: { max: 100, windowMs: 60_000 },
        adultConfirmation: { max: 100, windowMs: 60_000 },
      },
    });
  });
  afterAll(() => h.close());

  it('answers 429 after the checkout allowance is used up', async () => {
    const who = await account(h);
    await call(h, who, 'PUT', '/api/payments/adult-confirmation', {
      confirmed: true,
      password: PASSWORD,
    });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await call(h, who, 'POST', '/api/payments/checkout/pack', {
        packId: 'pearls-1200',
        consent: CONSENT,
      });
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('answers 429 after the cancel allowance is used up', async () => {
    const who = await account(h);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await call(h, who, 'POST', '/api/payments/subscription/cancel')).statusCode);
    }
    expect(statuses).toEqual([409, 409, 429]);
  });
});

describe('payments disabled with a running subscription', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('does not let an incomplete subscription older than a day block the deletion', async () => {
    const who = await account(h);
    await h.database.db.insert(schema.clubSubscriptions).values({
      id: newIds().subscription,
      userId: who.userId,
      status: 'incomplete',
      statusEventAt: new Date(h.clock.now()),
      createdAt: new Date(Date.now() - 2 * DAY_MS),
    });
    const res = await call(h, who, 'POST', '/api/me/delete', { password: PASSWORD });
    expect(res.statusCode, res.body).toBeLessThan(300);
  });

  it('refuses to delete the account rather than leave a subscription billing', async () => {
    const who = await account(h);
    await h.database.db.insert(schema.clubSubscriptions).values({
      id: newIds().subscription,
      userId: who.userId,
      status: 'active',
      statusEventAt: new Date(h.clock.now()),
    });
    const res = await call(h, who, 'POST', '/api/me/delete', { password: PASSWORD });
    expect(res.statusCode, res.body).toBe(503);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('payments_disabled');
    const [still] = await h.database.db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, who.userId));
    expect(still).toBeDefined();
  });
});
