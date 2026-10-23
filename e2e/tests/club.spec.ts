import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  APP_URL,
  PASSWORD,
  advanceServerClock,
  openDock,
  openTank,
  registerVerifiedUser,
} from '../support/app.ts';
import { balance, createTank, errorOf, me, sameOrigin } from '../support/api.ts';
import { economy, webPack } from '../support/economy.ts';
import { event, newStripeIds, sign } from '../support/stripe.ts';

const CONSENT = { immediateDelivery: true, withdrawalWaiver: true };
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const perDay = economy.subscription.pearlsPerDay;

interface PaymentsState {
  adultConfirmed: boolean;
  subscription: { status: string; paidUntil: string | null; cancelAtPeriodEnd: boolean } | null;
}

async function adultConfirmed(page: Page): Promise<void> {
  const res = await page.request.put('/api/payments/adult-confirmation', {
    ...sameOrigin,
    data: { confirmed: true, password: PASSWORD },
  });
  expect(res.ok(), 'adult confirmation').toBe(true);
}

async function paymentsState(page: Page): Promise<PaymentsState> {
  const res = await page.request.get('/api/payments/state');
  expect(res.ok(), 'GET /api/payments/state').toBe(true);
  return (await res.json()) as PaymentsState;
}

interface Row {
  reason: string;
  delta: number;
  createdAt: string;
}

async function ledger(page: Page): Promise<Row[]> {
  const res = await page.request.get('/api/wallet');
  expect(res.ok(), 'GET /api/wallet').toBe(true);
  return ((await res.json()) as { ledger: Row[] }).ledger;
}

async function serverNowMs(page: Page): Promise<number> {
  const stamps = (await ledger(page)).map((row) => Date.parse(row.createdAt));
  if (stamps.length === 0)
    throw new Error('a fresh account has no ledger row to read the clock from');
  return Math.max(...stamps);
}

const clubRows = (rows: Row[]) =>
  rows.filter((row) => row.reason === 'subscription').map((row) => row.delta);

function deliver(
  stripe: APIRequestContext,
  payload: string,
): ReturnType<APIRequestContext['post']> {
  return stripe.post('/api/payments/webhook', {
    data: payload,
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
  });
}

function invoicePaid(
  userId: string,
  subscriptionId: string,
  window: { startMs: number; endMs: number },
  invoiceId: string,
  offerId: string = economy.subscription.id,
): string {
  const start = Math.floor(window.startMs / 1000);
  const end = Math.floor(window.endMs / 1000);
  return event('invoice.paid', {
    id: invoiceId,
    object: 'invoice',
    amount_paid: economy.subscription.priceCents,
    currency: 'eur',
    billing_reason: 'subscription_cycle',
    period_start: start,
    period_end: end,
    lines: { object: 'list', data: [{ period: { start, end } }] },
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: subscriptionId,
        metadata: {
          user_id: userId,
          offer_id: offerId,
          consent_immediate_delivery: 'true',
          consent_withdrawal_waiver: 'true',
          consent_at: new Date().toISOString(),
        },
      },
    },
  });
}

function subscriptionEvent(type: string, userId: string, subscriptionId: string): string {
  return event(type, {
    id: subscriptionId,
    object: 'subscription',
    status: 'active',
    cancel_at_period_end: false,
    metadata: { user_id: userId, offer_id: economy.subscription.id },
  });
}

test.describe('Aquarist Club in test mode', () => {
  let stripe: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    stripe = await playwright.request.newContext({ baseURL: APP_URL });
  });

  test.afterAll(async () => {
    await stripe.dispose();
  });

  async function member(page: Page, paidForMs: number) {
    const { id: userId } = await me(page);
    const subscriptionId = newStripeIds().subscription;
    const before = await balance(page);
    const now = await serverNowMs(page);
    const payload = invoicePaid(
      userId,
      subscriptionId,
      { startMs: now - HOUR_MS, endMs: now + paidForMs },
      newStripeIds().invoice,
    );
    const paid = await deliver(stripe, payload);
    expect(paid.status(), await paid.text()).toBe(200);
    return { userId, before, payload };
  }

  test('a paid invoice starts the membership, which pays once per day until the paid period ends', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'club');
    const { id: userId } = await me(page);
    const subscriptionId = newStripeIds().subscription;
    const before = await balance(page);
    const now = await serverNowMs(page);

    expect((await paymentsState(page)).subscription).toBeNull();

    const created = await deliver(
      stripe,
      subscriptionEvent('customer.subscription.created', userId, subscriptionId),
    );
    expect(created.status(), await created.text()).toBe(200);
    expect(clubRows(await ledger(page)), 'no paid invoice yet, so no grant').toEqual([]);

    const payload = invoicePaid(
      userId,
      subscriptionId,
      { startMs: now - HOUR_MS, endMs: now + 60 * HOUR_MS },
      newStripeIds().invoice,
    );
    const paid = await deliver(stripe, payload);
    expect(paid.status(), await paid.text()).toBe(200);

    const state = await paymentsState(page);
    expect(state.subscription?.status).toBe('active');
    expect(state.subscription?.paidUntil).not.toBeNull();

    expect(await balance(page), 'the first visit of the day pays').toBe(before + perDay);
    expect(await balance(page), 'every later visit that day finds it taken').toBe(before + perDay);
    expect(clubRows(await ledger(page))).toEqual([perDay]);

    expect((await deliver(stripe, payload)).status()).toBe(200);
    expect(await balance(page), 'a redelivered invoice grants nothing extra').toBe(before + perDay);

    await advanceServerClock(page, 24 * 60);
    expect(await balance(page)).toBe(before + 2 * perDay);
    await advanceServerClock(page, 24 * 60);
    expect(await balance(page)).toBe(before + 3 * perDay);

    await advanceServerClock(page, 24 * 60);
    expect(await balance(page), 'the paid period is over, so the Pearls stop').toBe(
      before + 3 * perDay,
    );
    await advanceServerClock(page, 24 * 60);
    expect(await balance(page)).toBe(before + 3 * perDay);
  });

  test('an invoice for another offer, or one with a bad signature, grants nothing', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'clubstray');
    const { id: userId } = await me(page);
    const before = await balance(page);
    const now = await serverNowMs(page);
    const window = { startMs: now - HOUR_MS, endMs: now + 5 * DAY_MS };

    const foreign = invoicePaid(
      userId,
      newStripeIds().subscription,
      window,
      newStripeIds().invoice,
      'some-other-offer',
    );
    expect((await deliver(stripe, foreign)).status()).toBe(200);

    const unsigned = await stripe.post('/api/payments/webhook', {
      data: invoicePaid(userId, newStripeIds().subscription, window, newStripeIds().invoice),
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' },
    });
    expect(unsigned.status()).toBeGreaterThanOrEqual(400);

    expect(await balance(page)).toBe(before);
    expect((await paymentsState(page)).subscription).toBeNull();
    expect(clubRows(await ledger(page))).toEqual([]);
  });

  test('cancelling takes one step, keeps the paid days, and a second cancel changes nothing', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'clubcancel');
    const none = await page.request.post('/api/payments/subscription/cancel', sameOrigin);
    expect(none.status()).toBe(409);
    expect((await errorOf(none)).message).toBe('You have no active subscription.');

    const { before } = await member(page, 60 * HOUR_MS);
    const start = await balance(page);
    expect(start).toBe(before + perDay);

    const cancelled = await page.request.post('/api/payments/subscription/cancel', sameOrigin);
    expect(cancelled.status(), await cancelled.text()).toBe(200);
    expect(((await cancelled.json()) as PaymentsState).subscription?.cancelAtPeriodEnd).toBe(true);
    expect((await paymentsState(page)).subscription?.cancelAtPeriodEnd).toBe(true);

    const again = await page.request.post('/api/payments/subscription/cancel', sameOrigin);
    expect(again.status()).toBe(200);
    expect(((await again.json()) as PaymentsState).subscription?.cancelAtPeriodEnd).toBe(true);

    await advanceServerClock(page, 24 * 60);
    expect(await balance(page), 'a cancelled membership keeps paying until the paid end').toBe(
      start + perDay,
    );
  });

  test('the account settings cancel the membership with one click', async ({ page }) => {
    test.setTimeout(240_000);
    await page.route('**/assets/**', (route) => {
      const { pathname } = new URL(route.request().url());
      return /\.(js|css)$/.test(pathname) ? route.continue() : route.abort();
    });
    await registerVerifiedUser(page, 'clubui');
    await member(page, 20 * DAY_MS);

    await page.goto('/settings?backend=webgl&tier=low');
    const purchases = page.getByRole('region', { name: 'Purchases' });
    await expect(purchases).toContainText('You are an Aquarist Club member. Paid until');
    await purchases.getByRole('button', { name: 'Cancel membership' }).click();
    await expect(purchases.getByRole('status')).toContainText(
      'Your membership is cancelled. It keeps working until the end of the paid period.',
    );
    await expect(purchases).toContainText(
      'Your Aquarist Club membership is cancelled and runs until',
    );
    await expect(purchases.getByRole('button', { name: 'Cancel membership' })).toHaveCount(0);
    expect((await paymentsState(page)).subscription?.cancelAtPeriodEnd).toBe(true);
  });
});

test.describe('the Checkout redirect', () => {
  test.use({ serviceWorkers: 'block' });

  async function leavesForStripe(page: Page): Promise<Promise<string>> {
    let resolve: (url: string) => void = () => undefined;
    const seen = new Promise<string>((done, fail) => {
      resolve = done;
      setTimeout(() => fail(new Error('the browser never left for Checkout within 90 s')), 90_000);
    });
    await page.route(
      (url) => url.origin !== APP_URL,
      (route) => {
        if (route.request().resourceType() !== 'document') return route.abort();
        resolve(route.request().url());
        return route.fulfill({
          contentType: 'text/html',
          body: '<title>Checkout stand-in</title>',
        });
      },
    );
    return seen;
  }

  async function readyShop(page: Page, label: string) {
    await registerVerifiedUser(page, label);
    await createTank(page, { name: 'Pond' });
    await adultConfirmed(page);
    await openTank(page);
    const shop = await openDock(page, 'Shop', 'Fish shop');
    await shop.getByRole('checkbox', { name: 'I want my Pearls delivered right away.' }).check();
    await shop
      .getByRole('checkbox', {
        name: 'I understand that this ends my 14-day right of withdrawal for what I buy.',
      })
      .check();
    return shop;
  }

  test('Buy sends the browser to the Checkout URL the server returned', async ({ page }) => {
    test.setTimeout(420_000);
    const target = await leavesForStripe(page);
    const shop = await readyShop(page, 'redirect');
    const pack = webPack('pearls-550');

    await shop
      .getByRole('list', { name: 'Pearl packs' })
      .getByRole('button', { name: new RegExp(`^Buy ${pack.pearls} Pearls`) })
      .click();
    const url = await target;
    expect(url).toMatch(/^https:\/\//);
    await expect(page).toHaveTitle('Checkout stand-in');
  });

  test('Join sends the browser to the subscription Checkout URL', async ({ page }) => {
    test.setTimeout(420_000);
    const target = await leavesForStripe(page);
    const shop = await readyShop(page, 'redirectsub');

    await shop
      .getByRole('button', {
        name: `Join the Aquarist Club for €${(economy.subscription.priceCents / 100).toFixed(2)} a month`,
      })
      .click();
    expect(await target).toMatch(/^https:\/\//);
    await expect(page).toHaveTitle('Checkout stand-in');
  });

  test('without the adult confirmation the server refuses and the page stays put', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'noredirect');
    const checkout = await page.request.post('/api/payments/checkout/pack', {
      ...sameOrigin,
      data: { packId: webPack('pearls-550').id, consent: CONSENT },
    });
    expect(checkout.status()).toBe(403);
    expect((await errorOf(checkout)).code).toBe('adult_confirmation_required');
  });
});
